import { prisma } from '../prisma';
import { getUserProfile, normalizeScore, RecommendationScore } from './utils';

export async function getContentBasedScores(
  userId: number
): Promise<Map<number, RecommendationScore>> {
  const profile = await getUserProfile(userId);
  
  if (profile.totalWatched === 0) {
    return new Map();
  }

  const topGenres = Array.from(profile.favoriteGenres.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre]) => genre);

  if (topGenres.length === 0) {
    return new Map();
  }

  // Используем прямой SQL для получения кандидатов
  const candidateFilms = await prisma.$queryRaw<any[]>`
    SELECT f.*, 
      COALESCE(AVG(r.rating), 0) as avg_rating
    FROM "Film" f
    LEFT JOIN "Review" r ON r."filmId" = f.id
    WHERE f.id NOT IN (
      SELECT r."filmId" FROM "Review" r WHERE r."userId" = ${userId}
    )
    GROUP BY f.id
    LIMIT 100
  `;

  const scores = new Map<number, RecommendationScore>();
  
  for (const film of candidateFilms) {
    let totalScore = 0;
    const matchedGenres: string[] = [];
    
    // Получаем жанры: предполагаем, что genres уже массив (jsonb)
    let filmGenres: string[] = [];
    if (film.genres) {
      if (Array.isArray(film.genres)) {
        filmGenres = film.genres;
      } else if (typeof film.genres === 'string') {
        try {
          filmGenres = JSON.parse(film.genres);
        } catch (e) {
          filmGenres = [];
        }
      }
    }
    
    for (const genre of filmGenres) {
      const genreWeight = profile.favoriteGenres.get(genre) || 0;
      totalScore += genreWeight;
      if (genreWeight > 0) matchedGenres.push(genre);
    }
    
    if (filmGenres.length > 0) {
      totalScore = totalScore / filmGenres.length;
    } else {
      totalScore = 0;
    }
    
    // Добавляем бонус за средний рейтинг фильма (нормализованный)
    const avgFilmRating = Number(film.avg_rating) || 0;
    totalScore += (avgFilmRating / 5) * 0.3;
    
    if (totalScore > 0) {
      const normalizedScore = normalizeScore(totalScore, 0, 1.3);
      scores.set(film.id, {
        filmId: film.id,
        score: normalizedScore,
        reasons: [`Похож на ваши любимые фильмы (жанры: ${matchedGenres.slice(0, 3).join(', ')})`]
      });
    }
  }
  
  return scores;
}