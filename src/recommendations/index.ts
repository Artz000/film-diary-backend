import express from 'express';
import { prisma } from '../prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = express.Router();

router.get('/api/recommendations', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    console.log(`[Recommendations] Request for user ${userId}`);

    // Отключаем кэширование на всех уровнях
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', ''); // удаляем ETag, чтобы браузер не кэшировал

    // Получаем топ-20 фильмов по количеству рецензий (популярные)
    const popularFilms = await prisma.film.findMany({
      take: 20,
      orderBy: {
        reviews: {
          _count: 'desc'
        }
      },
      include: {
        _count: {
          select: { reviews: true }
        }
      }
    });

    if (popularFilms.length === 0) {
      console.log('[Recommendations] No films found in database');
      return res.json({ recommendations: [], source: 'none', total: 0 });
    }

    const result = popularFilms.map(film => ({
      film: {
        id: film.tmdbId,
        title: film.title,
        poster: film.posterPath,
        year: film.year,
        genres: film.genres
      },
      score: Math.min(0.5 + film._count.reviews / 100, 1.0),
      reasons: ['Популярный фильм']
    }));

    console.log(`[Recommendations] Returning ${result.length} popular films`);
    res.json({ recommendations: result, source: 'popular', total: result.length });
  } catch (error) {
    console.error('[Recommendations] Error:', error);
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
    console.log(`[Feedback] User ${userId} gave ${feedback} for film ${filmId}`);
    // Здесь можно сохранять фидбек, если нужно
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

export default router;