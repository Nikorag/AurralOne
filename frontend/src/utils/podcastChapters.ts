export type PodcastChapter = {
  startSeconds: number;
  title: string;
  imageUrl: string | null;
  url: string | null;
};

export function chapterIndexAt(chapters: readonly PodcastChapter[], position: number) {
  let index = -1;
  for (let candidate = 0; candidate < chapters.length; candidate += 1) {
    if ((chapters[candidate]?.startSeconds ?? Infinity) <= position + 0.25) index = candidate;
    else break;
  }
  return index;
}
