import type { CallOptions } from './roles';

/*
 * Deterministic (non-AI) services the stages depend on. They are injected, so stages stay pure and
 * testable; production implementations live in @vc/providers (network) and @vc/media (ffmpeg).
 */

export type FetchedPage = { url: string; title: string; text: string };

/** Fetches a public web page and extracts its readable text. Sends no credentials. */
export interface PageFetcher {
  fetchPage(url: string, options?: CallOptions): Promise<FetchedPage>;
}

export type ImageLicense =
  | 'cc0'
  | 'pdm'
  | 'by'
  | 'by-sa'
  | 'by-nc'
  | 'by-nd'
  | 'by-nc-sa'
  | 'by-nc-nd'
  | 'sampling+'
  | 'nc-sampling+';

export type ImageCandidate = {
  id: string;
  provider: string;
  url: string;
  thumbnailUrl: string | null;
  title: string;
  tags: string[];
  width: number | null;
  height: number | null;
  license: string;
  licenseVersion: string | null;
  licenseUrl: string | null;
  creator: string | null;
  /** Landing page for attribution. */
  sourceUrl: string | null;
  mature?: boolean;
};

export type ImageQuery = {
  query: string;
  aspect: '16:9' | '9:16' | '1:1';
  /** Licences acceptable for the output (commercial-safe by default). */
  licenses: readonly string[];
  pageSize: number;
};

/** Keyword image search (Openverse). Not AI. */
export interface ImageSource {
  readonly id: string;
  search(query: ImageQuery, options?: CallOptions): Promise<ImageCandidate[]>;
}
