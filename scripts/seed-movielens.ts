import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import csv from 'csv-parser';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Путь к распакованным файлам
const MOVIELENS_PATH = 'C:/Users/User/movielens'; // поменяйте на свой

interface MovieRow {
  movieId: string;
  title: string;
  genres: string;
}

interface RatingRow {
  userId: string;
  movieId: string;
  rating: string;
  timestamp: string;
}

async function seed() {
  console.log('🚀 Начинаем импорт MovieLens...');

  // 1. Создаём пользователей (уникальные email и tgId)
  const usersMap = new Map<string, number>(); // внешний userId -> наш id
  const ratingsByUser = new Map<string, RatingRow[]>(); // для группировки оценок

  // Сначала прочитаем все оценки, чтобы узнать уникальных пользователей
  const ratings: RatingRow[] = [];
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(path.join(MOVIELENS_PATH, 'ratings.csv'))
      .pipe(csv())
      .on('data', (data: RatingRow) => {
        ratings.push(data);
        if (!ratingsByUser.has(data.userId)) {
          ratingsByUser.set(data.userId, []);
        }
        ratingsByUser.get(data.userId)!.push(data);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`📊 Найдено ${ratingsByUser.size} пользователей и ${ratings.length} оценок`);

  // Создаём пользователей
  for (const [extUserId, userRatings] of ratingsByUser.entries()) {
    // Пропускаем, если у пользователя меньше 3 оценок (иначе рекомендации не будут работать)
    if (userRatings.length < 3) continue;

    const email = `movielens_${extUserId}@example.com`;
    const passwordHash = await bcrypt.hash('password123', 10); // общий пароль для всех тестовых
    const name = `MovieLens User ${extUserId}`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
    });
    usersMap.set(extUserId, user.id);
    console.log(`✅ Создан пользователь ${email} (id: ${user.id}) с ${userRatings.length} оценками`);
  }

  // 2. Читаем фильмы
  const movies: MovieRow[] = [];
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(path.join(MOVIELENS_PATH, 'movies.csv'))
      .pipe(csv())
      .on('data', (data: MovieRow) => movies.push(data))
      .on('end', resolve)
      .on('error', reject);
  });
  console.log(`📀 Загружено ${movies.length} фильмов`);

  // Создаём фильмы (movieId -> наш filmId)
  const filmMap = new Map<string, number>();
  for (const movie of movies) {
    // Преобразуем жанры из строки с разделителем | в массив
    const genresArray = movie.genres.split('|').filter(g => g !== '(no genres listed)');
    // Заглушка для постера (можно оставить пустым)
    const posterPath = null;
    // Год извлекаем из названия (часто в скобках в конце)
    let year = null;
    const yearMatch = movie.title.match(/\((\d{4})\)/);
    if (yearMatch) year = yearMatch[1];

    try {
      const film = await prisma.film.create({
        data: {
          tmdbId: parseInt(movie.movieId), // используем movieId как tmdbId
          title: movie.title.replace(/\s*\(\d{4}\)\s*$/, ''), // убираем год из названия
          posterPath,
          year,
          genres: genresArray,
        },
      });
      filmMap.set(movie.movieId, film.id);
    } catch (err) {
      console.error(`Ошибка при создании фильма ${movie.title}:`, err);
    }
  }
  console.log(`🎬 Создано ${filmMap.size} фильмов`);

  // 3. Добавляем оценки (рецензии)
  let reviewCount = 0;
  for (const rating of ratings) {
    const ourUserId = usersMap.get(rating.userId);
    const ourFilmId = filmMap.get(rating.movieId);
    if (!ourUserId || !ourFilmId) continue; // пропускаем, если пользователь или фильм не созданы

    const ratingValue = Math.round(parseFloat(rating.rating)); // округляем до целого (0.5 -> 1 и т.д.)
    if (ratingValue < 1 || ratingValue > 5) continue;

    try {
      await prisma.review.create({
        data: {
          userId: ourUserId,
          filmId: ourFilmId,
          status: 'watched',
          rating: ratingValue,
          reviewText: null,
          isPublic: true,     // делаем публичными, чтобы лента работала
          isFavorite: ratingValue >= 4, // фильмы с оценкой 4-5 считаем любимыми (опционально)
        },
      });
      reviewCount++;
    } catch (err) {
      console.error(`Ошибка при добавлении оценки: ${rating.userId} ${rating.movieId}`, err);
    }
  }

  console.log(`✅ Импорт завершён: ${usersMap.size} пользователей, ${filmMap.size} фильмов, ${reviewCount} рецензий`);
}

seed()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });