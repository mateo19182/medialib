import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import initialSchema from "../migrations/0001_initial_schema.sql?raw";
import mediaListFields from "../migrations/0002_media_list_fields.sql?raw";
import mediaSourceIdentity from "../migrations/0003_media_source_identity.sql?raw";
import sourceKindIdentity from "../migrations/0004_source_kind_identity.sql?raw";
import externalIdsAndCoverBackfill from "../migrations/0005_external_ids_and_cover_backfill.sql?raw";
import liveShows from "../migrations/0006_live_shows.sql?raw";
import artistType from "../migrations/0007_artist_type.sql?raw";
import trackArtistLookup from "../migrations/0008_track_artist_lookup.sql?raw";
import youtubeMusicMigration from "../migrations/0009_youtube_music_migration.sql?raw";
import unifiedItemSources from "../migrations/0010_unified_item_sources.sql?raw";
import youtubeSourceSync from "../migrations/0011_youtube_source_sync.sql?raw";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0001_initial_schema.sql", queries: [initialSchema] },
    { name: "0002_media_list_fields.sql", queries: [mediaListFields] },
    { name: "0003_media_source_identity.sql", queries: [mediaSourceIdentity] },
    { name: "0004_source_kind_identity.sql", queries: [sourceKindIdentity] },
    { name: "0005_external_ids_and_cover_backfill.sql", queries: [externalIdsAndCoverBackfill] },
    { name: "0006_live_shows.sql", queries: [liveShows] },
    { name: "0007_artist_type.sql", queries: [artistType] },
    { name: "0008_track_artist_lookup.sql", queries: [trackArtistLookup] },
    { name: "0009_youtube_music_migration.sql", queries: [youtubeMusicMigration] },
    { name: "0010_unified_item_sources.sql", queries: [unifiedItemSources] },
    { name: "0011_youtube_source_sync.sql", queries: [youtubeSourceSync] },
  ]);
});
