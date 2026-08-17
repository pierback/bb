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

export interface PierbackPreV037MigrationCutover {
  canonicalPrerequisiteTags: readonly string[];
  canonicalReplacementTag: string;
  supersededMigrations: readonly SupersededMigrationIdentity[];
}

export interface PierbackV037MigrationCutover {
  canonicalPrerequisiteTags: readonly string[];
  canonicalReplacementTags: readonly [string, string];
  supersededMigrations: readonly SupersededMigrationIdentity[];
}

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
  ],
  canonicalReplacementTag: "0099_pierback_self_hosted_session_fabric",
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
} as const satisfies PierbackPreV037MigrationCutover;

/**
 * Pierback 0.37.7 shipped its private schema as 0093/0094 immediately before
 * upstream claimed those ordinals. The 0.38 hard cutover installs upstream's
 * official 0093-0098 chain, records the regenerated Pierback schema as 0099,
 * and moves the idempotent data cleanup to 0100. Only an exact non-empty
 * prefix of the released 0.37.7 tail is accepted.
 */
export const pierbackV037MigrationCutover = {
  canonicalPrerequisiteTags: [
    "0093_peaceful_thing",
    "0094_mighty_polaris",
    "0095_normal_elektra",
    "0096_heavy_shiva",
    "0097_whole_blackheart",
    "0098_rename_curated_marketplace",
  ],
  canonicalReplacementTags: [
    "0099_pierback_self_hosted_session_fabric",
    "0100_purge_obsolete_provider_rate_limits",
  ],
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
} as const satisfies PierbackV037MigrationCutover;

export const publishedMigrationWhensByTag: ReadonlyMap<string, number> =
  new Map(publishedMigrationWhens.map((entry) => [entry.tag, entry.when]));
