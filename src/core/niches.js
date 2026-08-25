/**
 * Niche options for an influencer's profile.
 *
 * Plain data, shown by both the web profile form and the mobile one. Kept in
 * core so the two never offer different lists.
 */

const NICHES_F = ['Fashion', 'Beauty', 'Lifestyle', 'Wellness', 'Fitness', 'Travel', 'Food & Dining', 'Home & Decor', 'Parenting', 'Entertainment', 'Other']
const NICHES_M = ['Fitness', 'Gaming', 'Tech', 'Sports', 'Finance', 'Cars & Motors', 'Travel', 'Outdoor & Adventure', 'Food & Dining', 'Entertainment', 'Other']
const NICHES_ALL = ['Fashion', 'Fitness', 'Lifestyle', 'Beauty', 'Tech', 'Gaming', 'Travel', 'Food & Dining', 'Finance', 'Entertainment', 'Wellness', 'Sports', 'Other']

/** @param {string} gender 'Female' | 'Male' | anything else */
export function getNiches(gender) {
  return gender === 'Female' ? NICHES_F : gender === 'Male' ? NICHES_M : NICHES_ALL
}

export { NICHES_F, NICHES_M, NICHES_ALL }
