import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authMiddleware, AuthRequest } from './middleware/auth';
import recommendationsRouter from './recommendations';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const KINOPOISK_API_KEY = process.env.KINOPOISK_API_KEY;
const KINOPOISK_API_URL = 'https://api.kinopoisk.dev/v1.4';

export const prisma = new PrismaClient();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'https://film-diary-frontend1.vercel.app','https://web.telegram.org',
  'https://*.telegram.org'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('FilmDiary backend is running'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------------------------
// Аутентификация
// ---------------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name || email.split('@')[0],
      },
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------
// Лента (публичные рецензии)
// ---------------------------
app.get('/api/feed', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { sort = 'date', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    let orderBy: any = { createdAt: 'desc' };
    if (sort === 'popular') {
      orderBy = { likes: { _count: 'desc' } };
    }

    const reviews = await prisma.review.findMany({
      where: { isPublic: true },
      orderBy,
      skip,
      take: Number(limit),
      include: {
        user: { select: { id: true, name: true, email: true } },
        film: true,
        _count: { select: { likes: true } },
        likes: { where: { userId: req.userId }, select: { userId: true } },
      },
    });

    const total = await prisma.review.count({ where: { isPublic: true } });

    const feed = reviews.map(review => ({
      id: review.id,
      userName: review.user.name || review.user.email.split('@')[0],
      filmTitle: review.film.title,
      filmYear: review.film.year,
      filmGenres: review.film.genres,
      filmPoster: review.film.posterPath,
      rating: review.rating,
      reviewText: review.reviewText,
      createdAt: review.createdAt,
      likesCount: review._count.likes,
      likedByMe: review.likes.length > 0,
    }));

    res.json({
      data: feed,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------
// Работа с фильмами пользователя
// ---------------------------
app.post('/api/films', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { tmdbId, title, posterPath, year, genres, status, rating, reviewText, isPublic = false } = req.body;

    if (!tmdbId || !title || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Найти или создать фильм
    let film = await prisma.film.findUnique({ where: { tmdbId: Number(tmdbId) } });
    if (!film) {
      film = await prisma.film.create({
        data: {
          tmdbId: Number(tmdbId),
          title,
          posterPath,
          year: year ? String(year) : null,
          genres: genres || [],
        },
      });
    }

    // Создать рецензию
    const review = await prisma.review.create({
      data: {
        userId,
        filmId: film.id,
        status,
        rating: status === 'watched' ? rating : null,
        reviewText: reviewText || null,
        isPublic,
        isFavorite: status === 'favorite',
      },
    });

    res.status(201).json({ success: true, reviewId: review.id });
  } catch (err) {
    console.error('Error adding film:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получение фильмов текущего пользователя (по токену)
app.get('/api/users/me/films', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.userId;
  const { status, favorite } = req.query;

  const whereCondition: any = { userId };
  if (status && typeof status === 'string') whereCondition.status = status;
  if (favorite === 'true') whereCondition.isFavorite = true;

  try {
    const reviews = await prisma.review.findMany({
      where: whereCondition,
      include: { film: true },
      orderBy: { createdAt: 'desc' },
    });

    const films = reviews.map((review) => ({
      id: review.film.tmdbId,
      reviewId: review.id,
      title: review.film.title,
      poster: review.film.posterPath,
      year: review.film.year,
      genres: review.film.genres,
      status: review.status,
      rating: review.rating,
      reviewText: review.reviewText,
      isPublic: review.isPublic,
      isFavorite: review.isFavorite,
      createdAt: review.createdAt,
    }));

    res.json(films);
  } catch (error) {
    console.error('Error fetching user films:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/films/:tmdbId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const tmdbId = parseInt(req.params.tmdbId);
    const { status, rating, reviewText } = req.body;

    const film = await prisma.film.findUnique({ where: { tmdbId } });
    if (!film) return res.status(404).json({ error: 'Film not found' });

    const updated = await prisma.review.updateMany({
      where: { userId, filmId: film.id },
      data: {
        status,
        rating: status === 'watched' ? rating : null,
        reviewText: reviewText || undefined,
      },
    });

    if (updated.count === 0) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating film status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/films/:tmdbId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const tmdbId = parseInt(req.params.tmdbId);

    const film = await prisma.film.findUnique({ where: { tmdbId } });
    if (!film) return res.status(404).json({ error: 'Film not found' });

    await prisma.review.deleteMany({ where: { userId, filmId: film.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting film:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------
// Рецензии (лайки, публикация, рейтинг)
// ---------------------------
app.patch('/api/reviews/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const reviewId = parseInt(req.params.id);
    const { isPublic } = req.body;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: { isPublic },
    });
    res.json({ success: true, isPublic: updated.isPublic });
  } catch (err) {
    console.error('Error updating review visibility:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/reviews/:id/rating', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const reviewId = parseInt(req.params.id);
    const { rating } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const updated = await prisma.review.update({ where: { id: reviewId }, data: { rating } });
    res.json({ success: true, rating: updated.rating });
  } catch (err) {
    console.error('Error updating rating:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/reviews/:id/like', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const reviewId = parseInt(req.params.id);
    await prisma.like.create({ data: { userId, reviewId } });
    res.json({ success: true });
  } catch (err) {
    console.error('Error liking review:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/reviews/:id/like', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const reviewId = parseInt(req.params.id);
    await prisma.like.delete({ where: { userId_reviewId: { userId, reviewId } } });
    res.json({ success: true });
  } catch (err) {
    console.error('Error unliking review:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/films/:id/favorite', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.userId;
  const filmId = parseInt(req.params.id);
  const { isFavorite } = req.body; // true/false

  try {
    const film = await prisma.film.findUnique({ where: { tmdbId: filmId } });
    if (!film) return res.status(404).json({ error: 'Film not found' });

    const review = await prisma.review.updateMany({
      where: { userId, filmId: film.id },
      data: { isFavorite },
    });
    if (review.count === 0) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------
// API Кинопоиска
// ---------------------------
app.get('/api/kinopoisk/search', async (req, res) => {
  try {
    const { query, limit = 10, page = 1 } = req.query;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query parameter is required' });
    }
    if (!KINOPOISK_API_KEY) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const response = await axios.get(`${KINOPOISK_API_URL}/movie/search`, {
      headers: { 'X-API-KEY': KINOPOISK_API_KEY, Accept: 'application/json' },
      params: { query, limit, page },
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

    res.json({ films, total: response.data.total, page: response.data.page, pages: response.data.pages });
  } catch (err) {
    console.error('Kinopoisk error:', err);
    res.status(500).json({ error: 'Failed to fetch from Kinopoisk' });
  }
});

app.get('/api/kinopoisk/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!KINOPOISK_API_KEY) return res.status(500).json({ error: 'API key missing' });

    const response = await axios.get(`${KINOPOISK_API_URL}/movie/${id}`, {
      headers: { 'X-API-KEY': KINOPOISK_API_KEY, Accept: 'application/json' },
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
  } catch (err) {
    console.error('Kinopoisk error:', err);
    res.status(500).json({ error: 'Failed to fetch movie details' });
  }
});

// ---------------------------
// Статистика пользователя
// ---------------------------
app.get('/api/statistics', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const reviews = await prisma.review.findMany({
      where: { userId },
      include: { film: true },
    });

    const totalWatched = reviews.filter(r => r.status === 'watched').length;
    const totalWant = reviews.filter(r => r.status === 'want').length;
    const totalFavorite = reviews.filter(r => r.status === 'favorite' || r.isFavorite).length;
    const watchedRatings = reviews.filter(r => r.status === 'watched' && r.rating !== null).map(r => r.rating!);
    const averageRating = watchedRatings.length > 0
      ? watchedRatings.reduce((a, b) => a + b, 0) / watchedRatings.length
      : 0;

    // Активность по месяцам (последние 6 месяцев)
    const now = new Date();
    const months: { year: number; month: number; count: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth(), count: 0 });
    }
    reviews.forEach(r => {
      if (r.status === 'watched' && r.createdAt) {
        const date = new Date(r.createdAt);
        const idx = months.findIndex(m => m.year === date.getFullYear() && m.month === date.getMonth());
        if (idx !== -1) months[idx].count++;
      }
    });
    const monthlyActivity = months.map(m => ({ month: `${m.year}-${m.month + 1}`, count: m.count }));

    // Жанровая статистика
    const genreMap = new Map<string, number>();
    reviews.forEach(r => {
      if (r.status === 'watched' && r.film.genres) {
        let genres: string[] = [];
        if (Array.isArray(r.film.genres)) {
          genres = r.film.genres as string[];
        } else if (typeof r.film.genres === 'string') {
          try {
            genres = JSON.parse(r.film.genres);
          } catch {
            genres = [];
          }
        }
        genres.forEach((genre: string) => {
          genreMap.set(genre, (genreMap.get(genre) || 0) + 1);
        });
      }
    });
    const genreStats = Array.from(genreMap.entries())
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      totalWatched,
      totalWant,
      totalFavorite,
      averageRating,
      monthlyActivity,
      genreStats,
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fallback для любых других запросов
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use('*', (req, res) => res.status(200).send('OK'));
app.use(recommendationsRouter);

// Запуск сервера
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});