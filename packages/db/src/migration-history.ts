export interface PublishedMigrationWhen {
  tag: string;
  when: number;
}

export interface CompatibleMigrationHash {
  hash: string;
  tag: string;
  when: number;
}

export interface SupersededMigrationIdentity {
  hash: string;
  when: number;
}

export interface PierbackMigrationCutover {
  canonicalPrerequisiteTags: readonly string[];
  canonicalSchemaReplacementTag: string;
  predecessor: string;
  supersededMigrations: readonly SupersededMigrationIdentity[];
}

const bbV0431PrerequisiteTags = [
  "0110_many_kree",
  "0111_known_morph",
  "0112_steer_on_enter_default",
  "0113_environment_providers",
  "0114_public_iron_lad",
  "0115_ui_preferences",
  "0116_majestic_swordsman",
  "0117_machine_providers",
  "0118_brave_marvel_zombies",
] as const;

const bbMeshV0431SchemaReplacementTag = "0119_bb_mesh_session_fabric" as const;

export const publishedMigrationWhens = [
  { tag: "0000_baseline", when: 1778891867195 },
  { tag: "0001_terminal_session_user_input", when: 1779139400000 },
  { tag: "0002_closed_session_prune_indexes", when: 1779139400001 },
] as const satisfies readonly PublishedMigrationWhen[];

export const compatibleMigrationHashes = [
  {
    tag: "0031_mysterious_zaran",
    when: 1781403656069,
    hash: "bc111f5134183c37cf135af70231ec5a79823f9868818fdd8377e1ab3c05a23f",
  },
  {
    tag: "0039_thread_search",
    when: 1781660000001,
    hash: "025358fe89253aec7f5bd970dc3eb88d0e834f0d58fb9d75329a5d39899340f4",
  },
  {
    tag: "0103_wandering_mongoose",
    when: 1787181956957,
    hash: "79d39e7b68d1db8ba02614fe4cc227cc0c154d77c7183f2e37ed2d8475412993",
  },
  {
    tag: "0111_known_morph",
    when: 1788219579088,
    hash: "eda4daf7f011d8718c21d3fbd71030f30438863cd1e6ceddd32a5052fb3a14cd",
  },
] as const satisfies readonly CompatibleMigrationHash[];

/**
 * The private Pierback preview shipped six branch-local migrations after
 * upstream 0087. Upstream 0.37 subsequently claimed 0088-0092, so the release
 * line consolidates the preview schema after the official 0.38 migrations.
 * Preview builds
 * existed after each migration landed, making every non-empty, exact prefix a
 * supported predecessor for the one-way production cutover. Gapped, reordered,
 * or modified histories are rejected.
 */
export const pierbackPreV037MigrationCutover = {
  canonicalPrerequisiteTags: [
    "0088_narrow_kronos",
    "0089_chemical_darwin",
    "0090_equal_reaper",
    "0091_daffy_dark_phoenix",
    "0092_windy_doctor_faustus",
    "0093_peaceful_thing",
    "0094_mighty_polaris",
    "0095_normal_elektra",
    "0096_heavy_shiva",
    "0097_whole_blackheart",
    "0098_rename_curated_marketplace",
    "0099_flawless_maximus",
    "0100_flippant_psylocke",
    "0101_thread_search_prefix_fts",
    "0102_app_settings_key_value",
    "0103_wandering_mongoose",
    "0104_chunky_redwing",
    "0105_provider_settings_to_plugins",
    "0106_thread_state_index",
    "0107_kind_based_indexes",
    "0108_deferred_thread_messages",
    "0109_marketplace_install_stats",
    ...bbV0431PrerequisiteTags,
  ],
  canonicalSchemaReplacementTag: bbMeshV0431SchemaReplacementTag,
  predecessor: "pre-v0.37 Pierback",
  supersededMigrations: [
    {
      when: 1786137975011,
      hash: "c3cedc2eb8822910fbdfe8182ed681c37d01f819ad351255e0e2edd030022060",
    },
    {
      when: 1786181878174,
      hash: "bc631c89ae7100a1fa6f50e73d4db8101a683688b56aadfbdd2bbddc508a0141",
    },
    {
      when: 1786212266976,
      hash: "4e4ba5a87d84344df55c46bf50c89d5333106886d4a29f0a0e76e238d1d16547",
    },
    {
      when: 1786214854888,
      hash: "b4875d78d6cb70c7cebe3767c818611c78c54eb3c4ce0c54ba0e12410f01bd15",
    },
    {
      when: 1786217017074,
      hash: "22e5f1ff57f442f831fdcbc2c3486c940dd4616122a66bb4b006612ae8267fcf",
    },
    {
      when: 1786222185386,
      hash: "448fdddae6719097928358d2631205129a6efdc7830d53fdb369c5b704119551",
    },
  ],
} as const satisfies PierbackMigrationCutover;

/**
 * Pierback 0.37.7 shipped its private schema as 0093/0094 immediately before
 * upstream claimed those ordinals. The 0.38 hard cutover installs upstream's
 * official migration chain and records the regenerated Mesh schema after it.
 * Only an exact non-empty prefix of the released 0.37.7 tail is accepted.
 */
export const pierbackV037MigrationCutover = {
  canonicalPrerequisiteTags: [
    "0093_peaceful_thing",
    "0094_mighty_polaris",
    "0095_normal_elektra",
    "0096_heavy_shiva",
    "0097_whole_blackheart",
    "0098_rename_curated_marketplace",
    "0099_flawless_maximus",
    "0100_flippant_psylocke",
    "0101_thread_search_prefix_fts",
    "0102_app_settings_key_value",
    "0103_wandering_mongoose",
    "0104_chunky_redwing",
    "0105_provider_settings_to_plugins",
    "0106_thread_state_index",
    "0107_kind_based_indexes",
    "0108_deferred_thread_messages",
    "0109_marketplace_install_stats",
    ...bbV0431PrerequisiteTags,
  ],
  canonicalSchemaReplacementTag: bbMeshV0431SchemaReplacementTag,
  predecessor: "Pierback 0.37",
  supersededMigrations: [
    {
      when: 1786565472266,
      hash: "31775876e01b947f9bd07708d400fe67d9a088ce9e645afa44476a585a481034",
    },
    {
      when: 1786565503951,
      hash: "bc631c89ae7100a1fa6f50e73d4db8101a683688b56aadfbdd2bbddc508a0141",
    },
  ],
} as const satisfies PierbackMigrationCutover;

/**
 * Pierback 0.38.3 shipped four private migrations after upstream 0098. Their
 * timestamps are newer than upstream 0.40's official 0099-0109 tail, so
 * Drizzle's high-water mark would otherwise skip the official migrations and
 * then replay the private schema under its new 0110 identity. The hard cutover
 * accepts only an exact non-empty prefix of the released tail, applies the
 * official migrations, verifies or completes the private schema, and retires
 * the superseded rows atomically.
 */
export const pierbackV038MigrationCutover = {
  canonicalPrerequisiteTags: [
    "0099_flawless_maximus",
    "0100_flippant_psylocke",
    "0101_thread_search_prefix_fts",
    "0102_app_settings_key_value",
    "0103_wandering_mongoose",
    "0104_chunky_redwing",
    "0105_provider_settings_to_plugins",
    "0106_thread_state_index",
    "0107_kind_based_indexes",
    "0108_deferred_thread_messages",
    "0109_marketplace_install_stats",
    ...bbV0431PrerequisiteTags,
  ],
  canonicalSchemaReplacementTag: bbMeshV0431SchemaReplacementTag,
  predecessor: "Pierback 0.38",
  supersededMigrations: [
    {
      when: 1786958320912,
      hash: "31775876e01b947f9bd07708d400fe67d9a088ce9e645afa44476a585a481034",
    },
    {
      when: 1786958327612,
      hash: "bc631c89ae7100a1fa6f50e73d4db8101a683688b56aadfbdd2bbddc508a0141",
    },
    {
      when: 1787053295124,
      hash: "f8aa93196a9aeb1c5cee83e8ec1597db6ac0395d467d7101304e302eb221c74b",
    },
    {
      when: 1787685686506,
      hash: "955e87175b177168dbe8b93e1297e344bcad225d935975a4fa528cfb2c22f3ad",
    },
  ],
} as const satisfies PierbackMigrationCutover;

/**
 * BB Mesh 0.40 shipped its custom schema under private 0110/0111 identities.
 * Official BB 0.43.1 owns those ordinals. The one-way cutover applies the
 * official 0110-0118 chain, preserves the already-created Mesh tables and
 * data, and records their regenerated schema under 0119.
 */
export const bbMeshV040MigrationCutover = {
  canonicalPrerequisiteTags: bbV0431PrerequisiteTags,
  canonicalSchemaReplacementTag: bbMeshV0431SchemaReplacementTag,
  predecessor: "BB Mesh 0.40",
  supersededMigrations: [
    {
      when: 1787873440620,
      hash: "48b74a3e00c991156e08124ef8e4bbe0c70c073cf7257de7e12edcb6824f3b55",
    },
    {
      when: 1787873515295,
      hash: "bc631c89ae7100a1fa6f50e73d4db8101a683688b56aadfbdd2bbddc508a0141",
    },
  ],
} as const satisfies PierbackMigrationCutover;

/**
 * BB Mesh 0.43 shipped its schema under private 0118/0119 identities before
 * official BB 0.43.1 claimed 0118. Install official 0118, retain every Mesh
 * table and row under the regenerated 0119 schema identity, and retire only
 * the superseded ledger rows.
 */
export const bbMeshV043MigrationCutover = {
  canonicalPrerequisiteTags: bbV0431PrerequisiteTags,
  canonicalSchemaReplacementTag: bbMeshV0431SchemaReplacementTag,
  predecessor: "BB Mesh 0.43",
  supersededMigrations: [
    {
      when: 1789255828565,
      hash: "865b43ed198c15b0b9a1b4a2f1f33bd5729a9e692e94785f7c941ced5641cb41",
    },
    {
      when: 1789255834385,
      hash: "bc631c89ae7100a1fa6f50e73d4db8101a683688b56aadfbdd2bbddc508a0141",
    },
  ],
} as const satisfies PierbackMigrationCutover;

export const publishedMigrationWhensByTag: ReadonlyMap<string, number> =
  new Map(publishedMigrationWhens.map((entry) => [entry.tag, entry.when]));
