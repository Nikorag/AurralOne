export interface DirectoryPodcast {
  provider: string;
  externalId: string;
  title: string;
  publisher: string | null;
  description: string | null;
  imageUrl: string | null;
  feedUrl: string | null;
  categories: string[];
}

export interface PodcastDirectory {
  id: string;
  label: string;
  available: () => boolean;
  search: (term: string, limit: number) => Promise<DirectoryPodcast[]>;
  trending: (options: { category?: string; limit: number }) => Promise<DirectoryPodcast[]>;
}

export const PODCAST_CATEGORIES = [
  { id: "arts", label: "Arts", itunes: 1301 },
  { id: "business", label: "Business", itunes: 1321 },
  { id: "comedy", label: "Comedy", itunes: 1303 },
  { id: "education", label: "Education", itunes: 1304 },
  { id: "fiction", label: "Fiction", itunes: 1483 },
  { id: "health", label: "Health & Fitness", itunes: 1512 },
  { id: "history", label: "History", itunes: 1487 },
  { id: "kids", label: "Kids & Family", itunes: 1305 },
  { id: "leisure", label: "Leisure", itunes: 1502 },
  { id: "music", label: "Music", itunes: 1310 },
  { id: "news", label: "News", itunes: 1489 },
  { id: "science", label: "Science", itunes: 1533 },
  { id: "society", label: "Society & Culture", itunes: 1324 },
  { id: "sports", label: "Sports", itunes: 1545 },
  { id: "technology", label: "Technology", itunes: 1318 },
  { id: "true-crime", label: "True Crime", itunes: 1488 },
  { id: "tv-film", label: "TV & Film", itunes: 1309 },
] as const;

export const findCategory = (id: string | undefined) =>
  PODCAST_CATEGORIES.find((category) => category.id === id);
