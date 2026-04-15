import express from 'express';
import { prisma } from '../prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = express.Router();

router.get('/api/recommendations', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    console.log(`[Recommendations] Request for user ${userId}`);

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

    // Отключаем кэширование
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', ''); // удаляем ETag
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
    // Здесь можно сохранять фидбек, но для заглушки просто ответим успехом
    console.log(`[Feedback] User ${userId} gave ${feedback} for film ${filmId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

export default router;