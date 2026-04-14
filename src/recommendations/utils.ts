import { prisma } from '../prisma';

export interface UserProfile {
  userId: number;
  favoriteGenres: Map<string, number>;
  avgRating: number;
  totalWatched: number;
  highRatedFilms: number[];
}

export interface RecommendationScore {
  filmId: number;
  score: number;
  reasons: string[];
}

export async function getUserProfile(userId: number): Promise<UserProfile> {
  const reviews = await prisma.review.findMany({
    where: {
      userId,
      status: 'watched',
      rating: { not: null }
    },
    include: { film: true }
  });

  const favoriteGenres = new Map<string, number>();
  let totalRating = 0;
  const highRatedFilms: number[] = [];

  reviews.forEach(review => {
    totalRating += review.rating || 0;
    
    if ((review.rating || 0) >= 4) {
      highRatedFilms.push(review.filmId);
    }

    const genres = review.film.genres as string[] || [];
    genres.forEach(genre => {
      const weight = (review.rating || 0) / 5;
      favoriteGenres.set(genre, (favoriteGenres.get(genre) || 0) + weight);
    });
  });

  return {
    userId,
    favoriteGenres,
    avgRating: reviews.length > 0 ? totalRating / reviews.length : 0,
    totalWatched: reviews.length,
    highRatedFilms
  };
}

export function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (score - min) / (max - min);
}

export async function filterWatchedFilms(
  userId: number,
  recommendations: RecommendationScore[]
): Promise<RecommendationScore[]> {
  const watched = await prisma.review.findMany({
    where: { userId },
    select: { filmId: true }
  });
  
  const watchedFilmIds = new Set(watched.map(w => w.filmId));
  
  return recommendations.filter(rec => !watchedFilmIds.has(rec.filmId));
}