const join = (origin: string, base: string, path: string) =>
  `${origin.replace(/\/+$/, "")}${base === "/" ? "" : base.replace(/\/+$/, "")}${path}`;

export const showLink = (origin: string, base: string, podcastId: number) =>
  join(origin, base, `/podcasts/${podcastId}`);

export const episodeLink = (origin: string, base: string, podcastId: number, episodeId: number) =>
  join(origin, base, `/podcasts/${podcastId}?episode=${episodeId}`);

export const addFeedLink = (origin: string, base: string, feedUrl: string) =>
  join(origin, base, `/podcasts/search?q=${encodeURIComponent(feedUrl)}`);

export const sharedEpisodeId = (search: string, podcastId: number) => {
  const raw = new URLSearchParams(search).get("episode");
  const id = Number(raw);
  return raw && Number.isSafeInteger(id) && id > 0 && podcastId > 0 ? id : null;
};

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}
