import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { parseResponse, type InferRequestType, type InferResponseType } from "hono/client";
import { useToast } from "../contexts/ToastContext";
import { podcastsClient } from "../utils/api/clients/podcasts.ts";
import { getApiErrorMessage } from "../utils/api/errors.ts";

export type PodcastHome = InferResponseType<typeof podcastsClient.home.$get, 200>;
export type PodcastDiscover = InferResponseType<typeof podcastsClient.discover.$get, 200>;
export type Podcast = InferResponseType<(typeof podcastsClient)[":id"]["$get"], 200>["podcast"];
export type PodcastEpisode = PodcastHome["continueListening"][number];
export type DirectoryPodcast = PodcastDiscover["trending"][number];
export type FollowSettings = InferRequestType<
  (typeof podcastsClient)[":id"]["settings"]["$patch"]
>["json"];
export type EpisodeFilter = NonNullable<
  InferRequestType<(typeof podcastsClient)[":id"]["episodes"]["$get"]>["query"]["filter"]
>;
export type EpisodeSort = NonNullable<
  InferRequestType<(typeof podcastsClient)[":id"]["episodes"]["$get"]>["query"]["sort"]
>;
export type PodcastDownload = InferResponseType<
  typeof podcastsClient.downloads.$get,
  200
>["downloads"][number];
export type PodcastAdminStatus = InferResponseType<typeof podcastsClient.admin.status.$get, 200>;

const ROOT = ["podcasts"] as const;
export const podcastKeys = {
  all: ROOT,
  home: [...ROOT, "home"] as const,
  discover: [...ROOT, "discover"] as const,
  library: [...ROOT, "library"] as const,
  history: [...ROOT, "history"] as const,
  podcast: (id: number) => [...ROOT, "podcast", id] as const,
  episodes: (id: number, filter: string, sort: string) =>
    [...ROOT, "episodes", id, filter, sort] as const,
  search: (term: string) => [...ROOT, "search", term] as const,
  category: (id: string) => [...ROOT, "category", id] as const,
  admin: [...ROOT, "admin"] as const,
  downloads: [...ROOT, "downloads"] as const,
  imports: [...ROOT, "imports"] as const,
};

export const invalidatePodcasts = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: podcastKeys.all });

const PAGE = 30;

export const usePodcastHome = () =>
  useQuery({
    queryKey: podcastKeys.home,
    queryFn: ({ signal }) => parseResponse(podcastsClient.home.$get({}, { init: { signal } })),
  });

export const usePodcastDiscover = () =>
  useQuery({
    queryKey: podcastKeys.discover,
    queryFn: ({ signal }) => parseResponse(podcastsClient.discover.$get({}, { init: { signal } })),
    staleTime: 10 * 60_000,
  });

export const usePodcastLibrary = () =>
  useQuery({
    queryKey: podcastKeys.library,
    queryFn: ({ signal }) => parseResponse(podcastsClient.library.$get({}, { init: { signal } })),
  });

export const usePodcast = (id: number) =>
  useQuery({
    queryKey: podcastKeys.podcast(id),
    queryFn: ({ signal }) =>
      parseResponse(
        podcastsClient[":id"].$get({ param: { id: String(id) } }, { init: { signal } }),
      ),
    enabled: Number.isSafeInteger(id) && id > 0,
  });

export const usePodcastEpisodes = (id: number, filter: EpisodeFilter, sort: EpisodeSort) =>
  useInfiniteQuery({
    queryKey: podcastKeys.episodes(id, filter, sort),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      parseResponse(
        podcastsClient[":id"].episodes.$get(
          { param: { id: String(id) }, query: { filter, sort, offset: String(pageParam) } },
          { init: { signal } },
        ),
      ),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
    enabled: Number.isSafeInteger(id) && id > 0,
  });

export const usePodcastHistory = () =>
  useInfiniteQuery({
    queryKey: podcastKeys.history,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      parseResponse(
        podcastsClient.history.$get({ query: { offset: String(pageParam) } }, { init: { signal } }),
      ),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
  });

export const usePodcastSearch = (term: string) =>
  useQuery({
    queryKey: podcastKeys.search(term),
    queryFn: ({ signal }) =>
      parseResponse(podcastsClient.search.$get({ query: { q: term } }, { init: { signal } })),
    enabled: term.trim().length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });

export const usePodcastCategory = (category: string) =>
  useQuery({
    queryKey: podcastKeys.category(category),
    queryFn: ({ signal }) =>
      parseResponse(
        podcastsClient.browse[":category"].$get({ param: { category } }, { init: { signal } }),
      ),
    staleTime: 10 * 60_000,
    retry: false,
  });

export const usePodcastDownloads = () =>
  useQuery({
    queryKey: podcastKeys.downloads,
    queryFn: ({ signal }) => parseResponse(podcastsClient.downloads.$get({}, { init: { signal } })),
    refetchInterval: (query) =>
      query.state.data?.downloads.some((item) =>
        ["pending", "queued", "downloading"].includes(item.state),
      )
        ? 3000
        : false,
  });

export type PodcastImportStatus = InferResponseType<typeof podcastsClient.opml.imports.$get, 200>;

export const usePodcastImports = () =>
  useQuery({
    queryKey: podcastKeys.imports,
    queryFn: ({ signal }) =>
      parseResponse(podcastsClient.opml.imports.$get({}, { init: { signal } })),
    refetchInterval: (query) => (query.state.data?.pending ? 2000 : false),
  });

export const useImportOpml = () =>
  useActionMutation(
    (opml: string) => parseResponse(podcastsClient.opml.$post({ json: { opml } })),
    { failure: "Couldn't import this file" },
  );

export const useClearPodcastImports = () =>
  useActionMutation(() => parseResponse(podcastsClient.opml.imports.$delete({})), {
    failure: "Couldn't clear the import results",
  });

export async function downloadOpml() {
  const response = await podcastsClient.opml.$get({});
  const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/x-opml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "aurral-podcasts.opml";
  link.click();
  URL.revokeObjectURL(url);
}

export const usePodcastAdminStatus = () =>
  useQuery({
    queryKey: podcastKeys.admin,
    queryFn: ({ signal }) =>
      parseResponse(podcastsClient.admin.status.$get({}, { init: { signal } })),
    refetchInterval: 15_000,
  });

function useActionMutation<Input, Output>(
  run: (input: Input) => Promise<Output>,
  { success, failure }: { success?: string | ((output: Output) => string); failure: string },
) {
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();
  return useMutation({
    mutationFn: run,
    onSuccess: (output) => {
      void invalidatePodcasts(queryClient);
      const message = typeof success === "function" ? success(output) : success;
      if (message) showSuccess(message);
    },
    onError: (error) => showError(getApiErrorMessage(error, failure)),
  });
}

export const useFollowPodcast = () =>
  useActionMutation(
    ({ id }: { id: number; title?: string }) =>
      parseResponse(podcastsClient[":id"].follow.$put({ param: { id: String(id) } })),
    {
      success: (output) => (output.podcast ? `Following ${output.podcast.title}` : "Following"),
      failure: "Couldn't follow this podcast",
    },
  );

export const useUnfollowPodcast = () =>
  useActionMutation(
    ({ id, removeHistory = false }: { id: number; removeHistory?: boolean }) =>
      parseResponse(
        podcastsClient[":id"].follow.$delete({
          param: { id: String(id) },
          query: removeHistory ? { removeHistory: "true" } : {},
        }),
      ),
    { success: "Unfollowed", failure: "Couldn't unfollow this podcast" },
  );

export const useUpdatePodcastSettings = () =>
  useActionMutation(
    ({ id, ...json }: { id: number } & FollowSettings) =>
      parseResponse(podcastsClient[":id"].settings.$patch({ param: { id: String(id) }, json })),
    { failure: "Couldn't save podcast settings" },
  );

export const useImportPodcast = () =>
  useActionMutation(
    (json: { feedUrl: string; provider?: string; externalId?: string; follow?: boolean }) =>
      parseResponse(podcastsClient.import.$post({ json })),
    { failure: "Couldn't add this feed" },
  );

export const useRefreshPodcast = () =>
  useActionMutation(
    ({ id }: { id: number }) =>
      parseResponse(podcastsClient[":id"].refresh.$post({ param: { id: String(id) } })),
    { success: "Checked for new episodes", failure: "Couldn't refresh this podcast" },
  );

type EpisodeAction = "played" | "unplayed" | "download" | "remove-download" | "remove-history";

export const useEpisodeAction = () =>
  useActionMutation(
    async ({ id, action }: { id: number; action: EpisodeAction }) => {
      const param = { id: String(id) };
      const episode = podcastsClient.episodes[":id"];
      if (action === "played") await parseResponse(episode.played.$post({ param }));
      else if (action === "unplayed") await parseResponse(episode.played.$delete({ param }));
      else if (action === "download") await parseResponse(episode.download.$post({ param }));
      else if (action === "remove-download") {
        await parseResponse(episode.download.$delete({ param }));
      } else await parseResponse(episode.history.$delete({ param }));
    },
    { failure: "Couldn't update this episode" },
  );

export const useSavePodcastAdminSettings = () =>
  useActionMutation(
    (json: InferRequestType<typeof podcastsClient.admin.settings.$patch>["json"]) =>
      parseResponse(podcastsClient.admin.settings.$patch({ json })),
    { success: "Podcast settings saved", failure: "Couldn't save podcast settings" },
  );

export const usePodcastAdminAction = () =>
  useActionMutation(
    async (action: "reconcile" | "refresh" | "retry-failed") => {
      if (action === "reconcile") await parseResponse(podcastsClient.admin.reconcile.$post({}));
      else if (action === "refresh") await parseResponse(podcastsClient.admin.refresh.$post({}));
      else await parseResponse(podcastsClient.admin["retry-failed"].$post({}));
    },
    { failure: "That didn't work" },
  );
