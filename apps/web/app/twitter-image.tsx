/**
 * Twitter card image route.
 *
 * Re-exports the OpenGraph image so the two URLs always emit the same
 * artifact. 1200×630 satisfies both `og:image` and Twitter's
 * `summary_large_image` aspect-ratio requirement.
 */

export {
  default,
  runtime,
  alt,
  size,
  contentType,
} from './opengraph-image';
