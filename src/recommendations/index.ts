import express from 'express';
import { prisma } from '../prisma';
import { getHybridRecommendations } from './hybrid';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = express.Router();

router.get('/api/recommendations', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const limit = parseInt(req.query.limit as string) || 20;
    const refresh = req.query.refresh === 'true';

    const userReviewsCount = await prisma.review.count({
      where: { userId }
    });

    let recommendations;
    let source = 'cache';

    if (userReviewsCount < 3) {
      recommendations = await getPopularRecommendations(userId, limit);
      source = 'popular';
    } else {
      recommendations = await getHybridRecommendations(userId, undefined, limit);
      source = 'hybrid';
    }

    const filmIds = recommendations.map(r => r.filmId);
    const films = await prisma.film.findMany({
      where: { id: { in: filmIds } }
    });

    const filmMap = new Map(films.map(f => [f.id, f]));

    const result = recommendations.map(rec => ({
      film: {
        id: filmMap.get(rec.filmId)?.tmdbId,
        title: filmMap.get(rec.filmId)?.title,
        poster: filmMap.get(rec.filmId)?.posterPath,
        year: filmMap.get(rec.filmId)?.year,
        genres: filmMap.get(rec.filmId)?.genres
      },
      score: rec.score,
      reasons: rec.reasons
    }));

    res.json({
      recommendations: result,
      source,
      total: result.length
    });
  } catch (error) {
    console.error('Error getting recommendations:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

router.post('/api/recommendations/feedback', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { filmId, feedback } = req.body;

    if (!filmId || !feedback) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await prisma.recommendationFeedback.upsert({
      where: {
        userId_filmId: { userId, filmId: Number(filmId) }
      },
      update: { feedback },
      create: {
        userId,
        filmId: Number(filmId),
        feedback
      }
    });

    // Очищаем кэш рекомендаций для этого пользователя
    await prisma.recommendationCache.deleteMany({
      where: { userId }
    });

    console.log(`[Feedback] User ${userId} gave ${feedback} for film ${filmId}, cache cleared`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

async function getPopularRecommendations(userId: number, limit: number) {
  const popularFilms = await prisma.film.findMany({
    where: {
      NOT: {
        reviews: { some: { userId } }
      }
    },
    include: {
      _count: {
        select: { reviews: true }
      }
    },
    orderBy: {
      reviews: { _count: 'desc' }
    },
    take: limit
  });

  return popularFilms.map(film => ({
    filmId: film.id,
    score: 0.5,
    reasons: ['Популярный фильм среди пользователей']
  }));
}

export default router;