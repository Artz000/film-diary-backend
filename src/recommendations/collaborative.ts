import { prisma } from '../prisma';
import { normalizeScore, RecommendationScore } from './utils';

export async function getCollaborativeScores(
  userId: number
): Promise<Map<number, RecommendationScore>> {
  const userRatings = await prisma.review.findMany({
    where: {
      userId,
      rating: { not: null }
    },
    select: { filmId: true, rating: true }
  });

  if (userRatings.length < 3) {
    return new Map();
  }

  const userRatingMap = new Map(userRatings.map(r => [r.filmId, r.rating]));

  const similarUsersData = await prisma.review.findMany({
    where: {
      filmId: { in: userRatings.map(r => r.filmId) },
      userId: { not: userId },
      rating: { not: null }
    },
    select: {
      userId: true,
      filmId: true,
      rating: true,
      user: {
        select: {
          reviews: {
            where: { rating: { not: null } },
            select: { filmId: true, rating: true }
          }
        }
      }
    }
  });

  const userSimilarity = new Map<number, { similarity: number; reviews: any[] }>();
  
  for (const otherUserData of similarUsersData) {
    const otherUserId = otherUserData.userId;
    
    if (!userSimilarity.has(otherUserId)) {
      const otherRatings = otherUserData.user.reviews;
      const commonFilms = userRatings.filter(ur => 
        otherRatings.some(or => or.filmId === ur.filmId)
      );
      
      if (commonFilms.length >= 2) {
        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;
        
        for (const common of commonFilms) {
          const otherRating = otherRatings.find(or => or.filmId === common.filmId)?.rating || 0;
          const userRating = common.rating || 0;
          
          dotProduct += userRating * otherRating;
          norm1 += userRating * userRating;
          norm2 += otherRating * otherRating;
        }
        
        const similarity = norm1 > 0 && norm2 > 0 ? dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2)) : 0;
        
        userSimilarity.set(otherUserId, {
          similarity,
          reviews: otherRatings
        });
      }
    }
  }

  const topSimilarUsers = Array.from(userSimilarity.entries())
    .sort((a, b) => b[1].similarity - a[1].similarity)
    .slice(0, 10)
    .filter(([, data]) => data.similarity > 0.3);

  const scores = new Map<number, RecommendationScore>();
  
  for (const [otherUserId, data] of topSimilarUsers) {
    for (const review of data.reviews) {
      if (userRatingMap.has(review.filmId)) continue;
      
      const currentScore = scores.get(review.filmId);
      const newScore = data.similarity * ((review.rating || 0) / 5);
      
      if (currentScore) {
        currentScore.score += newScore;
        if (!currentScore.reasons.includes('Нравится похожим пользователям')) {
          currentScore.reasons.push('Нравится похожим пользователям');
        }
      } else {
        scores.set(review.filmId, {
          filmId: review.filmId,
          score: newScore,
          reasons: ['Нравится похожим пользователям']
        });
      }
    }
  }

  const allScores = Array.from(scores.values());
  const maxScore = Math.max(...allScores.map(s => s.score), 0.01);
  
  for (const score of allScores) {
    score.score = normalizeScore(score.score, 0, maxScore);
  }
  
  return scores;
}