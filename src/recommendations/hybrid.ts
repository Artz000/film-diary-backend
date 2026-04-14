import { prisma } from '../prisma';
import { getContentBasedScores } from './contentBased';
import { getCollaborativeScores } from './collaborative';
import { filterWatchedFilms, RecommendationScore } from './utils';

interface HybridConfig {
  contentWeight: number;
  collabWeight: number;
  popularityBoost: number;
  minScore: number;
}

const DEFAULT_CONFIG: HybridConfig = {
  contentWeight: 0.4,
  collabWeight: 0.4,
  popularityBoost: 0.2,
  minScore: 0.3
};

export async function getHybridRecommendations(
  userId: number,
  config: HybridConfig = DEFAULT_CONFIG,
  limit: number = 20
): Promise<RecommendationScore[]> {
  
  const cached = await prisma.recommendationCache.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() }
    },
    orderBy: { score: 'desc' },
    take: limit
  });

  if (cached.length >= limit) {
    console.log(`[Recommendations] Using cached recommendations for user ${userId}`);
    return cached.map(c => ({
      filmId: c.filmId,
      score: Number(c.score),
      reasons: c.reasons as string[]
    }));
  }

  console.log(`[Recommendations] Generating fresh recommendations for user ${userId}`);

  const [contentScores, collabScores] = await Promise.all([
    getContentBasedScores(userId),
    getCollaborativeScores(userId)
  ]);

  const popularFilms = await prisma.film.findMany({
    where: {
      NOT: {
        reviews: { none: {} }
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
    take: 50
  });

  const popularityMap = new Map<number, number>();
  const maxReviews = Math.max(...popularFilms.map(f => f._count.reviews), 1);
  for (const film of popularFilms) {
    popularityMap.set(film.id, film._count.reviews / maxReviews);
  }

  const allFilmIds = new Set([
    ...contentScores.keys(),
    ...collabScores.keys()
  ]);

  const finalScores: RecommendationScore[] = [];

  for (const filmId of allFilmIds) {
    let totalScore = 0;
    const reasons: string[] = [];

    const contentScore = contentScores.get(filmId);
    if (contentScore) {
      totalScore += contentScore.score * config.contentWeight;
      reasons.push(...contentScore.reasons);
    }

    const collabScore = collabScores.get(filmId);
    if (collabScore) {
      totalScore += collabScore.score * config.collabWeight;
      reasons.push(...collabScore.reasons);
    }

    const popularityBonus = (popularityMap.get(filmId) || 0) * config.popularityBoost;
    totalScore += popularityBonus;
    
    if (popularityBonus > 0 && !reasons.includes('Популярный фильм')) {
      reasons.push('Популярный фильм');
    }

    if (totalScore >= config.minScore) {
      finalScores.push({
        filmId,
        score: totalScore,
        reasons: [...new Set(reasons)]
      });
    }
  }

  const sorted = finalScores.sort((a, b) => b.score - a.score).slice(0, limit);
  
  const filtered = await filterWatchedFilms(userId, sorted);

  await prisma.recommendationCache.deleteMany({
    where: { userId }
  });

  await prisma.recommendationCache.createMany({
    data: filtered.map(rec => ({
      userId,
      filmId: rec.filmId,
      score: rec.score,
      reasons: rec.reasons,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    }))
  });

  return filtered;
}