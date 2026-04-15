import { prisma } from '../prisma';
import { normalizeScore, RecommendationScore } from './utils';

export async function getCollaborativeScores(
  userId: number
): Promise<Map<number, RecommendationScore>> {
  const userRatings = await prisma.review.findMany({
    where: { userId, rating: { not: null } },
    select: { filmId: true, rating: true }
  });
  const validUserRatings = userRatings.filter(r => r.rating !== null) as { filmId: number; rating: number }[];
  if (validUserRatings.length < 3) return new Map();

  const userRatingMap = new Map(validUserRatings.map(r => [r.filmId, r.rating]));

  const otherRatings = await prisma.review.findMany({
    where: {
      filmId: { in: validUserRatings.map(r => r.filmId) },
      userId: { not: userId },
      rating: { not: null }
    },
    select: { userId: true, filmId: true, rating: true }
  });

  const userReviewsMap = new Map<number, { filmId: number; rating: number }[]>();
  for (const item of otherRatings) {
    if (item.rating === null) continue;
    if (!userReviewsMap.has(item.userId)) userReviewsMap.set(item.userId, []);
    userReviewsMap.get(item.userId)!.push({ filmId: item.filmId, rating: item.rating });
  }

  const userSimilarity = new Map<number, { similarity: number; reviews: { filmId: number; rating: number }[] }>();

  for (const [otherUserId, otherReviews] of userReviewsMap.entries()) {
    const commonFilms = validUserRatings.filter(ur =>
      otherReviews.some(or => or.filmId === ur.filmId)
    );
    if (commonFilms.length >= 2) {
      let dotProduct = 0, norm1 = 0, norm2 = 0;
      for (const common of commonFilms) {
        const otherRating = otherReviews.find(or => or.filmId === common.filmId)?.rating || 0;
        const userRating = common.rating;
        dotProduct += userRating * otherRating;
        norm1 += userRating * userRating;
        norm2 += otherRating * otherRating;
      }
      const similarity = norm1 > 0 && norm2 > 0 ? dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2)) : 0;
      if (similarity > 0.3) {
        userSimilarity.set(otherUserId, { similarity, reviews: otherReviews });
      }
    }
  }

  const topSimilarUsers = Array.from(userSimilarity.entries())
    .sort((a, b) => b[1].similarity - a[1].similarity)
    .slice(0, 10);

  const scores = new Map<number, RecommendationScore>();
  for (const [, data] of topSimilarUsers) {
    for (const review of data.reviews) {
      if (userRatingMap.has(review.filmId)) continue;
      const currentScore = scores.get(review.filmId);
      const newScore = data.similarity * (review.rating / 5);
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