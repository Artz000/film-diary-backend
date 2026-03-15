import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const KINOPOISK_API_KEY = process.env.KINOPOISK_API_KEY;
const KINOPOISK_API_URL = 'https://api.kinopoisk.dev/v1.4';

// Prisma клиент
export const prisma = new PrismaClient();
async function connectDB() {
  try {
    await prisma.$connect();
    console.log('✅ База данных подключена');
  } catch (error) {
    console.error('❌ Ошибка подключения к БД:', error);
    // Не выходим из процесса, чтобы платформа могла показать ошибку
    // но можно и process.exit(1), если без БД работа невозможна
  }
}
connectDB();

// Middleware
app.use(cors({
  origin: [
    'https://film-diary-frontend1-66rcpd1mk-artz000s-projects.vercel.app', // твой фронтенд
    'http://localhost:5173'
  ],
  credentials: true,
}));
app.use(express.json());

// Вспомогательная функция валидации initData
function validateTelegramWebAppData(initData: string, botToken: string): boolean {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return calculatedHash === hash;
}

// ------------------------------
// 1. Тестовый маршрут
// ------------------------------
app.get('/', (req, res) => {
  res.send('FilmDiary backend is running');
});

// ------------------------------
// 2. Авторизация через Telegram
// ------------------------------
app.post('/api/auth', async (req, res) => {
  const { initData } = req.body;

  if (typeof initData !== 'string' || initData.trim() === '') {
    return res.status(400).json({ error: 'initData required' });
  }

  if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not defined in .env');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!validateTelegramWebAppData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const params = new URLSearchParams(initData);
  const userStr = params.get('user');
  if (!userStr) {
    return res.status(400).json({ error: 'No user data in initData' });
  }

  let tgUser;
  try {
    tgUser = JSON.parse(userStr);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid user data format' });
  }

  try {
    let user = await prisma.user.findUnique({
      where: { tgId: String(tgUser.id) },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          tgId: String(tgUser.id),
          firstName: tgUser.first_name || '',
          lastName: tgUser.last_name || '',
          username: tgUser.username || '',
          photoUrl: tgUser.photo_url || '',
        },
      });
    }

    res.json({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
      },
    });
  } catch (dbError) {
    console.error('Database error during auth:', dbError);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------
// 3. Эндпоинты для работы с фильмами пользователя
// ------------------------------

app.post('/api/films', async (req, res) => {
  try {
    const userId = req.headers['user-id'];
    const { tmdbId, title, posterPath, status, rating, reviewText } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }
    if (!tmdbId || !title || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let film = await prisma.film.findUnique({
      where: { tmdbId: Number(tmdbId) },
    });

    if (!film) {
      film = await prisma.film.create({
        data: {
          tmdbId: Number(tmdbId),
          title,
          posterPath,
        },
      });
    }

    const review = await prisma.review.create({
      data: {
        userId: Number(userId),
        filmId: film.id,
        status,
        rating: status === 'watched' ? rating : null,
        reviewText: reviewText || null,
      },
    });

    res.status(201).json({ success: true, reviewId: review.id });
  } catch (error) {
    console.error('Error adding film:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:userId/films', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { status } = req.query;

    const whereCondition: any = { userId };
    if (status && typeof status === 'string') {
      whereCondition.status = status;
    }

    const reviews = await prisma.review.findMany({
      where: whereCondition,
      include: { film: true },
      orderBy: { createdAt: 'desc' },
    });

    const films = reviews.map((review) => ({
      id: review.film.tmdbId,
      title: review.film.title,
      poster: review.film.posterPath,
      status: review.status,
      rating: review.rating,
      reviewText: review.reviewText,
      createdAt: review.createdAt,
    }));

    res.json(films);
  } catch (error) {
    console.error('Error fetching user films:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/films/:tmdbId', async (req, res) => {
  try {
    const userId = req.headers['user-id'];
    const tmdbId = parseInt(req.params.tmdbId);

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const film = await prisma.film.findUnique({
      where: { tmdbId },
    });

    if (!film) {
      return res.status(404).json({ error: 'Film not found' });
    }

    await prisma.review.deleteMany({
      where: {
        userId: Number(userId),
        filmId: film.id,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting film:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------
// 4. Эндпоинты для работы с Кинопоиском
// ------------------------------

app.get('/api/kinopoisk/search', async (req, res) => {
  try {
    const { query, limit = 10, page = 1 } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query parameter is required' });
    }
    if (!KINOPOISK_API_KEY) {
      console.error('KINOPOISK_API_KEY is not defined');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const response = await axios.get(`${KINOPOISK_API_URL}/movie/search`, {
      headers: {
        'X-API-KEY': KINOPOISK_API_KEY,
        'Accept': 'application/json',
      },
      params: {
        query: query,
        limit: limit,
        page: page,
      },
    });

    const films = response.data.docs.map((movie: any) => ({
      id: movie.id,
      title: movie.name || movie.alternativeName || movie.enName,
      year: movie.year,
      poster: movie.poster?.previewUrl || movie.poster?.url,
      rating: movie.rating?.kp || movie.rating?.imdb,
      description: movie.description,
      genres: movie.genres?.map((g: any) => g.name),
    }));

    res.json({
      films,
      total: response.data.total,
      page: response.data.page,
      pages: response.data.pages,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('Kinopoisk API error:', error.response?.data || error.message);
    } else {
      console.error('Kinopoisk API error:', error);
    }
    res.status(500).json({ error: 'Failed to fetch from Kinopoisk' });
  }
});

app.get('/api/kinopoisk/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!KINOPOISK_API_KEY) {
      console.error('KINOPOISK_API_KEY is not defined');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const response = await axios.get(`${KINOPOISK_API_URL}/movie/${id}`, {
      headers: {
        'X-API-KEY': KINOPOISK_API_KEY,
        'Accept': 'application/json',
      },
    });

    const movie = response.data;
    res.json({
      id: movie.id,
      title: movie.name || movie.alternativeName,
      year: movie.year,
      poster: movie.poster?.url,
      rating: movie.rating?.kp,
      description: movie.description,
      genres: movie.genres?.map((g: any) => g.name),
      countries: movie.countries?.map((c: any) => c.name),
      duration: movie.movieLength,
      ageRating: movie.ageRating,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('Kinopoisk API error:', error.response?.data || error.message);
    } else {
      console.error('Kinopoisk API error:', error);
    }
    res.status(500).json({ error: 'Failed to fetch movie details' });
  }
});

// ------------------------------
// 5. Запуск сервера с обработкой сигналов
// ------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Получен SIGTERM, закрываем сервер...');
  server.close(() => {
    console.log('Сервер остановлен');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('Неперехваченное исключение:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанный промис:', err);
  process.exit(1);
});