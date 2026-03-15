import express from 'express';
import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();
const KINOPOISK_API_KEY = process.env.KINOPOISK_API_KEY;
const KINOPOISK_API_URL = 'https://api.kinopoisk.dev/v1.4';

// Поиск фильмов по названию
router.get('/search', async (req, res) => {
  try {
    const { query, limit = 10, page = 1 } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const response = await axios.get(`${KINOPOISK_API_URL}/movie/search`, {
      headers: {
        'X-API-KEY': KINOPOISK_API_KEY,
        'Accept': 'application/json'
      },
      params: {
        query: query,
        limit: limit,
        page: page
      }
    });

    const films = response.data.docs.map((movie: any) => ({
      id: movie.id,
      title: movie.name || movie.alternativeName || movie.enName,
      year: movie.year,
      poster: movie.poster?.previewUrl || movie.poster?.url,
      rating: movie.rating?.kp || movie.rating?.imdb,
      description: movie.description,
      genres: movie.genres?.map((g: any) => g.name)
    }));

    res.json({
      films,
      total: response.data.total,
      page: response.data.page,
      pages: response.data.pages
    });
  } catch (error) {
    // Проверяем, является ли ошибка AxiosError
    if (axios.isAxiosError(error)) {
      console.error('Kinopoisk API error:', error.response?.data || error.message);
      res.status(500).json({ 
        error: 'Failed to fetch from Kinopoisk',
        details: error.response?.data 
      });
    } else {
      console.error('Unexpected error:', error);
      res.status(500).json({ error: 'Unexpected error occurred' });
    }
  }
});

// Получение деталей фильма по ID
router.get('/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const response = await axios.get(`${KINOPOISK_API_URL}/movie/${id}`, {
      headers: {
        'X-API-KEY': KINOPOISK_API_KEY,
        'Accept': 'application/json'
      }
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
      ageRating: movie.ageRating
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('Kinopoisk API error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to fetch movie details' });
    } else {
      console.error('Unexpected error:', error);
      res.status(500).json({ error: 'Unexpected error occurred' });
    }
  }
});

export default router;