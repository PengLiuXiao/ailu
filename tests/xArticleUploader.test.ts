import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

import {
  computeXArticleMediaBindingKey,
  discoverXArticleSkill,
  normalizeXArticleVisibleDomAnchor,
  normalizeXArticleVisibleAnchor,
  shouldAutoOpenXArticleDraft,
  validateXArticleVisibleAnchorContract,
  xArticleVisibleAnchorsMatch,
  XArticleLocalUploader,
  type XArticleUploaderDependencies,
} from '../src/xArticle/localUploader';
import {
  addPreparedMarkdownPreflightErrors,
  findUnsupportedXArticleDividers,
  findUnsupportedXArticleRawHtml,
  findUnsupportedXArticleReferenceImages,
  validateXArticlePreflight,
} from '../src/xArticle/preflight';
import type {
  PreparedXArticleMarkdown,
  XArticlePreflight,
  XArticleSkillRuntime,
} from '../src/xArticle/types';
import anchorNormalizationVectors from './fixtures/xArticleAnchorNormalizationVectors.json';

const runtime: XArticleSkillRuntime = {
  scriptsDirectory: '/skill/scripts',
  uploadScript: '/skill/scripts/upload_markdown_to_x_article.py',
  parseScript: '/skill/scripts/parse_markdown.py',
  cookieExportScript: '/skill/scripts/export_x_cookies_from_chrome.py',
  source: 'configured',
};

const draftUrl = 'https://x.com/compose/articles/edit/1234567890';
const expectedCompactSha256 = 'a'.repeat(64);
const mutationEpoch = 'x-article-upload-123456789';
const zeroVisualSignature = `visual-dhash-v1:${'0'.repeat(64)}`;

function visualSignatureWithBits(bitCount: number): string {
  const nibbles = Array.from({ length: 64 }, () => 0);
  for (let offset = 0; offset < bitCount; offset += 1) {
    const nibbleIndex = 63 - Math.floor(offset / 4);
    nibbles[nibbleIndex] |= 1 << (offset % 4);
  }
  return `visual-dhash-v1:${nibbles.map(value => value.toString(16)).join('')}`;
}

function visualHammingDistance(left: string, right: string): number {
  const leftHex = left.split(':')[1] ?? '';
  const rightHex = right.split(':')[1] ?? '';
  if (leftHex.length !== 64 || rightHex.length !== 64) throw new Error('invalid test dHash');
  return Array.from({ length: 64 }, (_, offset) => (
    Number.parseInt(leftHex[offset], 16) ^ Number.parseInt(rightHex[offset], 16)
  )).reduce((total, value) => total + value.toString(2).replaceAll('0', '').length, 0);
}

function prepared(): PreparedXArticleMarkdown {
  const rewrittenMarkdown = '# Prepared title\n\nBody ending sentence.\n';
  return {
    sourcePath: '/vault/article.md',
    sourceContentHash: 'source-hash',
    contentHash: createHash('sha256').update(rewrittenMarkdown, 'utf8').digest('hex'),
    path: '/tmp/prepared.md',
    title: 'Prepared title',
    coverPath: null,
    formatter: { title: 'Prepared title', cover: null },
    rewrittenMarkdown,
    resolvedImages: [],
    assetDigests: [],
    omittedRemoteImages: [],
  };
}

function dryRunJson(bodyImages = 0, coverUpload = false): Record<string, unknown> {
  const anchors = Array.from({ length: bodyImages }, (_, offset) => ({
    index: offset + 1,
    file: `image-${offset + 1}.png`,
    anchor: `Stable anchor ${offset + 1}`,
    placement: 'after-anchor',
  }));
  return {
    title: 'Prepared title',
    cover_image: coverUpload ? '/vault/cover.png' : null,
    recommended_cover_ratio: '5:2',
    cover_policy: {
      starts_with_image: coverUpload,
      first_content_line: 1,
      first_content_preview: coverUpload ? '![cover](/vault/cover.png)' : '# Prepared title',
    },
    cover_upload: coverUpload,
    cover_missing: !coverUpload,
    post_upload_cover_reminder: coverUpload ? '' : 'Please add a 5:2 cover.',
    expected_body_images: bodyImages,
    expected_tables: 0,
    tables: [],
    end_check_text: 'Body ending sentence.',
    content_checkpoints: ['Prepared', 'title', 'Body', 'ending', 'sentence.'],
    expected_compact_length: 32,
    compact_length_unit: 'unicode_code_points',
    checkpoint_position_unit: 'unicode_code_points',
    expected_compact_sha256: expectedCompactSha256,
    preflight: { errors: [], warnings: [] },
    anchors,
  };
}

function preflight(): XArticlePreflight {
  return validateXArticlePreflight(dryRunJson(), prepared().contentHash);
}

function strictPreReloadContent(): Record<string, unknown> {
  return {
    title: 'Prepared title',
    hasStart: true,
    hasEnd: true,
    marker: false,
    tableMarker: false,
    allCheckpointsMatched: true,
    checkpointsInOrder: true,
    exactCompactLength: true,
    exactCompactSha256: true,
    tableStripReliable: true,
    mediaStripReliable: true,
    expectedCompactLength: 32,
    compactTextLength: 32,
    expectedCompactSha256,
    contentCompactSha256: expectedCompactSha256,
    tableCount: 0,
    nativeTableNodesFound: 0,
    nativeMediaNodesFound: 0,
    verifiedMediaBindingKeys: [],
  };
}

function emptyMediaEvidence(): Record<string, unknown> {
  return {
    expected_count: 0,
    actual_count: 0,
    exact_count: true,
    duplicate_signatures_allowed: true,
    ordered_signatures: [],
    ordered_identity_keys: [],
    ordered_binding_keys: [],
    items: [],
    valid: true,
  };
}

function autosaveEvidence(epoch = mutationEpoch): Record<string, unknown> {
  const saving = {
    channelKey: 'testid:article-save-status',
    nodeInstance: 1,
    state: 'saving',
    text: '正在保存',
    attributes: { state: 'saving', status: '', version: '41', busy: 'true', datetime: '' },
    token: 'saving-v41',
    sequence: 1,
    observedAt: 10_010,
  };
  const saved = {
    channelKey: 'testid:article-save-status',
    nodeInstance: 1,
    state: 'saved',
    text: '刚刚最后保存',
    attributes: { state: 'saved', status: '', version: '42', busy: 'false', datetime: '' },
    token: 'saved-v42',
    sequence: 2,
    observedAt: 10_020,
  };
  return {
    epoch,
    startedAt: 10_000,
    mutationCount: 4,
    lastMutationAt: 10_005,
    lastMutationLabel: 'write_body',
    lastMutationEventCursor: 0,
    lastMutationSequence: 0,
    last_mutation_sequence: 0,
    mutationBaseline: [{ ...saving, sequence: undefined, observedAt: undefined }],
    current: [{ ...saved, sequence: undefined, observedAt: undefined }],
    events: [saving, saved],
    epoch_matches: true,
    relevant_events: [saving, saved],
    saving_to_saved_transitions: [{
      channel_key: 'testid:article-save-status',
      saving_sequence: 1,
      saved_sequence: 2,
    }],
    changed_saved_nodes: [saved],
    departure_to_saved_transitions: [],
    post_mutation_saved_observations: [],
    saved_state_present: true,
    verified: true,
  };
}

function zeroDraftState(): Record<string, unknown> {
  return {
    title: '',
    body_text: '',
    table_count: 0,
    body_media_count: 0,
    cover_media_count: 0,
    verified: true,
  };
}

function coverEvidence(
  uploaded = false,
  signature = `visual-dhash-v1:${'c'.repeat(64)}`,
  clearedBaselineCount: number | null = null,
): Record<string, unknown> {
  const sourceSignature = uploaded ? signature : '';
  return {
    expected_count: uploaded ? 1 : 0,
    actual_count: uploaded ? 1 : 0,
    exact_count: true,
    ordered_signatures: uploaded ? [signature] : [],
    source_signature: sourceSignature,
    source_hamming_distance: uploaded ? 0 : null,
    source_matches: true,
    signature_hamming_distance: uploaded ? 0 : null,
    signature_match: true,
    cleared_baseline_count: clearedBaselineCount,
    added_from_cleared_state: true,
    items: uploaded ? [{
      sourceSignature: signature,
      naturalWidth: 1500,
      naturalHeight: 600,
      sourceUrlKind: 'blob',
    }] : [],
    recognizable: true,
    valid: true,
  };
}

function strictUploadResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verification_contract: 'x-article-persistence-v1',
    title: 'Prepared title',
    draft_url: draftUrl,
    hasStart: true,
    hasEnd: true,
    endCheckText: 'Body ending sentence.',
    contentCheckpoints: ['Prepared', 'title', 'Body', 'ending', 'sentence.'],
    matchedCheckpoints: ['Prepared', 'title', 'Body', 'ending', 'sentence.'],
    checkpointPositions: [0, 8, 13, 17, 23],
    allCheckpointsMatched: true,
    checkpointsInOrder: true,
    exactCompactLength: true,
    exactCompactSha256: true,
    tableStripReliable: true,
    mediaStripReliable: true,
    expectedCompactLength: 32,
    compactTextLength: 32,
    compactLengthUnit: 'unicode_code_points',
    checkpointPositionUnit: 'unicode_code_points',
    expectedCompactSha256,
    contentCompactSha256: expectedCompactSha256,
    marker: false,
    tableMarker: false,
    media_count: 0,
    body_media_count: 0,
    expected_body_media: 0,
    expected_total_media: 0,
    tableCount: 0,
    expected_table_count: 0,
    nativeTableNodesFound: 0,
    nativeMediaNodesFound: 0,
    cover_uploaded: false,
    cover_missing: true,
    recommended_cover_ratio: '5:2',
    inserted: [],
    inserted_tables: [],
    source_media_contract: [],
    ordered_binding_keys: [],
    verifiedMediaBindingKeys: [],
    saveText: '刚刚最后保存',
    autosave_verified: true,
    persistence_verified: true,
    media_bindings_persisted: true,
    persistence_evidence: {
      reloaded: true,
      draft_url_before_reload: draftUrl,
      draft_url_after_reload: draftUrl,
      content_before_reload: strictPreReloadContent(),
      content_before_reload_verified: true,
      content_after_reload_verified: true,
      tables_before_reload: [],
      tables_after_reload: [],
      media_before_reload: emptyMediaEvidence(),
      media_after_reload: emptyMediaEvidence(),
      media_signatures_persisted: true,
      media_phase_persistence: {
        before_valid: true,
        after_valid: true,
        ordered_identities_match: true,
        observed_pre_post_hamming_distances: [],
        exact_signatures_equal: true,
        valid: true,
      },
      paste_bindings_verified: true,
      ordered_binding_keys: [],
      hosted_media_identity_persisted: true,
      media_bindings_persisted: true,
      mutation_epoch: mutationEpoch,
      autosave_before_reload: autosaveEvidence(),
      autosave_after_reload: {
        verification_required: false,
        reason: 'autosave proof is bound to the pre-reload mutation epoch; reload performs no mutation',
      },
      autosave_verified: true,
      replacement_clear: {
        mode: 'new_draft_blank',
        initial: zeroDraftState(),
        cleared: zeroDraftState(),
      },
      replacement_baseline_verified: true,
      cover_before_reload: coverEvidence(false, undefined, 0),
      cover_after_reload: coverEvidence(),
      cover_count_after_reload: 0,
      cover_signature_persisted: true,
      cover_signatures_exact: true,
      cover_pre_post_hamming_distance: null,
      cover_persisted: true,
      verified: true,
    },
    ...overrides,
  };
}

function tableMatrix(index: number): string[][] {
  return [[`Header ${index}`, 'Value'], [`Row ${index}`, `Cell ${index}`]];
}

function tableMarkdown(index: number): string {
  return `| Header ${index} | Value |\n| --- | --- |\n| Row ${index} | Cell ${index} |`;
}

function tableEvidence(index: number, phase: 'pre_reload' | 'post_reload'): Record<string, unknown> {
  const matrix = tableMatrix(index);
  return {
    index,
    dom_index: index - 1,
    rows: 2,
    columns: 2,
    expected_matrix: matrix,
    visible_matrix: matrix,
    visible_matrix_matches: true,
    visible_non_empty_cells: 4,
    readback_markdown: tableMarkdown(index),
    readback_matches: true,
    phase,
  };
}

function multiTablePreflight(count = 12): XArticlePreflight {
  return validateXArticlePreflight({
    ...dryRunJson(),
    expected_tables: count,
    tables: Array.from({ length: count }, (_, offset) => ({
      index: offset + 1,
      rows: 2,
      columns: 2,
      marker: `X_TABLE_MARKER_${String(offset + 1).padStart(3, '0')}_DO_NOT_EDIT`,
      normalized_matrix: tableMatrix(offset + 1),
    })),
  }, prepared().contentHash);
}

function strictMultiTableResult(count = 12): Record<string, unknown> {
  const insertedTables = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    return {
      index,
      rows: 2,
      columns: 2,
      marker: `X_TABLE_MARKER_${String(index).padStart(3, '0')}_DO_NOT_EDIT`,
      table_dom_index: offset,
      expected_matrix: tableMatrix(index),
      visible_matrix: tableMatrix(index),
      visible_matrix_matches: true,
      visible_non_empty_cells: 4,
      readback_markdown: tableMarkdown(index),
      readback_matches: true,
    };
  });
  const result = strictUploadResult({
    tableCount: count,
    expected_table_count: count,
    nativeTableNodesFound: count,
    inserted_tables: insertedTables,
  });
  const persistence = result.persistence_evidence as Record<string, unknown>;
  persistence.content_before_reload = {
    ...strictPreReloadContent(),
    tableCount: count,
    nativeTableNodesFound: count,
  };
  persistence.tables_before_reload = Array.from(
    { length: count },
    (_, offset) => tableEvidence(offset + 1, 'pre_reload'),
  );
  persistence.tables_after_reload = Array.from(
    { length: count },
    (_, offset) => tableEvidence(offset + 1, 'post_reload'),
  );
  return result;
}

function bodyImagePreflight(count = 2, coverUpload = false): XArticlePreflight {
  return validateXArticlePreflight({
    ...dryRunJson(count, coverUpload),
    cover_image: coverUpload ? '/vault/cover.png' : null,
  }, prepared().contentHash);
}

function sourceMediaContract(
  preflightValue: XArticlePreflight,
  sourceSignatures: string[],
): Record<string, unknown>[] {
  const occurrences = new Map<string, number>();
  return sourceSignatures.map((sourceSignature, offset) => {
    const occurrence = (occurrences.get(sourceSignature) ?? 0) + 1;
    occurrences.set(sourceSignature, occurrence);
    const anchor = preflightValue.anchors[offset];
    const bindingKey = computeXArticleMediaBindingKey(
      sourceSignature,
      occurrence,
      anchor.anchor,
      offset,
    );
    const expectedSourceSampleId = createHash('sha256')
      .update(`sample:${sourceSignature}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return {
      index: offset + 1,
      file: anchor.file,
      source_signature: sourceSignature,
      expected_source_sample_id: expectedSourceSampleId,
      source_natural_width: 1_536,
      source_natural_height: 1_024,
      occurrence,
      expected_anchor: anchor.anchor,
      placement: anchor.placement,
      expected_dom_order: offset,
      binding_key: bindingKey,
    };
  });
}

function uniqueSourceEvidenceFields(
  expectedSourceSignature: string,
  observedSignature: string,
  sourceSignatures: string[],
): Record<string, unknown> {
  const distinctSources = [...new Set(sourceSignatures)];
  const groups = distinctSources.map(sourceSignature => ({
    source_signature: sourceSignature,
    source_group_occurrences: sourceSignatures.filter(candidate => candidate === sourceSignature).length,
    hamming_distance: visualHammingDistance(sourceSignature, observedSignature),
  }));
  const nearestDistance = Math.min(...groups.map(group => group.hamming_distance));
  const nearestSignatures = groups
    .filter(group => group.hamming_distance === nearestDistance)
    .map(group => group.source_signature);
  const expectedIsUniqueNearest = nearestSignatures.length === 1
    && nearestSignatures[0] === expectedSourceSignature;
  const otherDistances = groups
    .filter(group => group.source_signature !== expectedSourceSignature)
    .map(group => group.hamming_distance);
  const secondNearestDistance = otherDistances.length > 0 ? Math.min(...otherDistances) : null;
  const expectedDistance = visualHammingDistance(expectedSourceSignature, observedSignature);
  return {
    distinct_source_group_count: groups.length,
    source_group_distances: groups,
    nearest_source_distance: nearestDistance,
    second_nearest_source_distance: secondNearestDistance,
    nearest_source_margin: expectedIsUniqueNearest && secondNearestDistance !== null
      ? secondNearestDistance - expectedDistance
      : null,
    nearest_source_signatures: nearestSignatures,
    nearest_source_ambiguous: nearestSignatures.length !== 1,
    source_ambiguous: nearestSignatures.length !== 1,
    expected_source_is_unique_nearest: expectedIsUniqueNearest,
  };
}

function applyAdaptiveVisualEvidence(value: Record<string, unknown>): void {
  value.source_matches = true;
  value.signature_match = true;
  value.strict_source_match = false;
  value.adaptive_source_match = true;
  value.sample_consensus_match = false;
  value.adaptive_margin_matches = true;
  value.source_natural_width = 1_536;
  value.source_natural_height = 1_024;
  value.observed_natural_width = 1_200;
  value.observed_natural_height = 800;
  value.natural_width = 1_200;
  value.natural_height = 800;
  value.aspect_ratio_relative_drift = 0;
  value.aspect_ratio_matches = true;
  value.match_policy = 'adaptive-unique-nearest';
}

function applySampleConsensusVisualEvidence(
  value: Record<string, unknown>,
  contract: Record<string, unknown>[],
  expectedOffset: number,
  options: {
    rgbError?: number;
    lumaError?: number;
    correlation?: number | null;
  } = {},
): void {
  const expected = contract[expectedOffset];
  const expectedSampleId = String(expected.expected_source_sample_id);
  const distinctSampleIds = [...new Set(contract.map(item => String(item.expected_source_sample_id)))];
  const rgbError = options.rgbError ?? 0.01;
  const lumaError = options.lumaError ?? 0.01;
  const correlation = options.correlation === undefined ? 0.99 : options.correlation;
  const groups = distinctSampleIds.map(sampleId => {
    const isExpected = sampleId === expectedSampleId;
    const groupRgbError = isExpected ? rgbError : 0.8;
    const groupLumaError = isExpected ? lumaError : 0.8;
    return {
      source_sample_id: sampleId,
      source_group_occurrences: contract.filter(
        item => item.expected_source_sample_id === sampleId,
      ).length,
      rgb_mean_absolute_error: groupRgbError,
      luma_mean_absolute_error: groupLumaError,
      luma_correlation: isExpected ? correlation : 0.1,
      sample_distance_score: groupRgbError * 0.6 + groupLumaError * 0.4,
    };
  });
  const expectedGroup = groups.find(group => group.source_sample_id === expectedSampleId);
  if (!expectedGroup) throw new Error('missing expected sample test group');
  const otherScores = groups
    .filter(group => group.source_sample_id !== expectedSampleId)
    .map(group => group.sample_distance_score);
  const secondNearestDistance = otherScores.length > 0 ? Math.min(...otherScores) : null;
  const sampleMargin = secondNearestDistance === null
    ? null
    : secondNearestDistance - expectedGroup.sample_distance_score;
  const dHashDistance = Number(value.source_hamming_distance);
  const dHashMargin = typeof value.nearest_source_margin === 'number'
    ? value.nearest_source_margin
    : null;
  const adaptiveMarginMatches = Number(value.distinct_source_group_count) === 1
    || (dHashMargin !== null && dHashMargin >= 16);
  const adaptiveSourceMatch = value.expected_source_is_unique_nearest === true
    && dHashDistance > 64
    && dHashDistance <= 80
    && adaptiveMarginMatches;
  const sampleSimilarityMatches = rgbError <= 0.12
    && lumaError <= 0.10
    && (correlation === null || correlation >= 0.88);
  const sampleMarginMatches = distinctSampleIds.length === 1
    || (sampleMargin !== null && sampleMargin >= 0.008)
    || adaptiveMarginMatches;
  value.source_matches = true;
  value.signature_match = true;
  value.strict_source_match = false;
  value.adaptive_source_match = adaptiveSourceMatch;
  value.sample_consensus_match = true;
  value.sample_similarity_matches = true;
  value.sample_margin_matches = sampleMarginMatches;
  value.distinct_source_sample_group_count = groups.length;
  value.source_sample_distances = groups;
  value.nearest_source_sample_distance = expectedGroup.sample_distance_score;
  value.second_nearest_source_sample_distance = secondNearestDistance;
  value.nearest_source_sample_margin = sampleMargin;
  value.expected_source_sample_id = expectedSampleId;
  value.expected_source_sample_is_unique_nearest = true;
  value.rgb_mean_absolute_error = rgbError;
  value.luma_mean_absolute_error = lumaError;
  value.luma_correlation = correlation;
  value.adaptive_margin_matches = adaptiveMarginMatches;
  value.source_natural_width = expected.source_natural_width;
  value.source_natural_height = expected.source_natural_height;
  value.observed_natural_width = 1_200;
  value.observed_natural_height = 800;
  value.natural_width = 1_200;
  value.natural_height = 800;
  value.aspect_ratio_relative_drift = 0;
  value.aspect_ratio_matches = true;
  value.match_policy = 'multi-signal-consensus';
  if (!sampleSimilarityMatches) {
    // Deliberately keep the claimed flag true so rejection tests prove the
    // verifier recomputes thresholds instead of trusting Python summaries.
    value.sample_similarity_matches = true;
  }
}

function bodyMediaEvidence(
  preflightValue: XArticlePreflight,
  contract: Record<string, unknown>[],
  observedSignatures: string[],
  phase: 'pre_reload' | 'post_reload',
  anchorOverrides: Record<number, string> = {},
): Record<string, unknown> {
  const bindingKeys = contract.map(item => String(item.binding_key));
  return {
    expected_count: observedSignatures.length,
    actual_count: observedSignatures.length,
    exact_count: true,
    duplicate_signatures_allowed: true,
    ordered_signatures: observedSignatures,
    ordered_identity_keys: bindingKeys,
    ordered_binding_keys: bindingKeys,
    phase_sentinel: phase,
    items: observedSignatures.map((observedSignature, offset) => {
      const anchor = preflightValue.anchors[offset];
      const source = contract[offset];
      const sourceSignature = String(source.source_signature);
      const signatureHammingDistance = visualHammingDistance(sourceSignature, observedSignature);
      return {
        index: offset + 1,
        file: anchor.file,
        source_signature: sourceSignature,
        observed_signature: observedSignature,
        source_natural_width: source.source_natural_width,
        source_natural_height: source.source_natural_height,
        source_hamming_distance: signatureHammingDistance,
        source_matches: signatureHammingDistance <= 64,
        ...uniqueSourceEvidenceFields(
          sourceSignature,
          observedSignature,
          contract.map(item => String(item.source_signature)),
        ),
        signature_hamming_distance: signatureHammingDistance,
        signature_match: signatureHammingDistance <= 64,
        source_occurrence: source.occurrence,
        observed_occurrence: source.occurrence,
        occurrence: source.occurrence,
        occurrence_matches: true,
        identity_key: source.binding_key,
        binding_key: source.binding_key,
        identity_matches: true,
        natural_width: 1200,
        natural_height: 800,
        dom_order: offset,
        expected_dom_order: offset,
        dom_order_matches: true,
        block_index: offset * 2 + 1,
        anchor_before: anchorOverrides[offset + 1] ?? anchor.anchor,
        expected_anchor: anchor.anchor,
        anchor_matches: true,
        recognizable: true,
      };
    }),
    valid: true,
  };
}

function strictBodyMediaResult(
  preflightValue: XArticlePreflight,
  options: {
    sourceSignatures?: string[];
    beforeObservedSignatures?: string[];
    afterObservedSignatures?: string[];
  } = {},
): Record<string, unknown> {
  const sourceSignatures = options.sourceSignatures ?? preflightValue.anchors.map(
    (_, offset) => `visual-dhash-v1:${(offset + 1).toString(16).repeat(64).slice(0, 64)}`,
  );
  const beforeObservedSignatures = options.beforeObservedSignatures ?? sourceSignatures;
  const afterObservedSignatures = options.afterObservedSignatures ?? beforeObservedSignatures;
  const contract = sourceMediaContract(preflightValue, sourceSignatures);
  const beforeEvidence = bodyMediaEvidence(
    preflightValue,
    contract,
    beforeObservedSignatures,
    'pre_reload',
  );
  const afterEvidence = bodyMediaEvidence(
    preflightValue,
    contract,
    afterObservedSignatures,
    'post_reload',
  );
  const bindingKeys = contract.map(item => String(item.binding_key));
  const inserted = preflightValue.anchors.map((anchor, offset) => {
    const before = beforeObservedSignatures.filter((_, signatureOffset) => signatureOffset > offset);
    const after = [beforeObservedSignatures[offset], ...before];
    const source = contract[offset];
    const signatureHammingDistance = visualHammingDistance(
      String(source.source_signature),
      beforeObservedSignatures[offset],
    );
    return {
      index: offset + 1,
      file: anchor.file,
      expected_anchor: anchor.anchor,
      placement: anchor.placement,
      anchor_used: anchor.anchor,
      source_signature: source.source_signature,
      observed_signature: beforeObservedSignatures[offset],
      signature_hamming_distance: signatureHammingDistance,
      signature_match: signatureHammingDistance <= 64,
      occurrence: source.occurrence,
      expected_dom_order: offset,
      binding_key: source.binding_key,
      paste_binding: {
        before_signatures: before,
        after_signatures: after,
        candidate_indices: [0],
        identity_candidate_indices: [0],
        matching_candidate_indices: [0],
        actual_dom_order: 0,
        expected_final_dom_order: offset,
        source_signature: source.source_signature,
        observed_signature: beforeObservedSignatures[offset],
        source_hamming_distance: signatureHammingDistance,
        ...uniqueSourceEvidenceFields(
          String(source.source_signature),
          beforeObservedSignatures[offset],
          sourceSignatures,
        ),
        signature_hamming_distance: signatureHammingDistance,
        signature_match: signatureHammingDistance <= 64,
        source_occurrence: source.occurrence,
        occurrence: source.occurrence,
        anchor_before: anchor.anchor,
        expected_anchor: anchor.anchor,
        anchor_matches: true,
        identity_key: source.binding_key,
        binding_key: source.binding_key,
        recognizable: true,
        valid: true,
      },
      persisted_media: (afterEvidence.items as Record<string, unknown>[])[offset],
      binding_persisted: true,
    };
  });
  const result = strictUploadResult({
    media_count: preflightValue.totalMedia,
    body_media_count: preflightValue.expectedBodyImages,
    expected_body_media: preflightValue.expectedBodyImages,
    expected_total_media: preflightValue.totalMedia,
    nativeMediaNodesFound: preflightValue.expectedBodyImages,
    cover_uploaded: preflightValue.coverUpload,
    cover_missing: preflightValue.coverMissing,
    inserted,
    source_media_contract: contract,
    ordered_binding_keys: bindingKeys,
    verifiedMediaBindingKeys: bindingKeys,
  });
  const persistence = result.persistence_evidence as Record<string, unknown>;
  persistence.media_before_reload = beforeEvidence;
  persistence.media_after_reload = afterEvidence;
  persistence.media_phase_persistence = {
    before_valid: true,
    after_valid: true,
    ordered_identities_match: true,
    observed_pre_post_hamming_distances: beforeObservedSignatures.map(
      (signature, offset) => visualHammingDistance(signature, afterObservedSignatures[offset]),
    ),
    exact_signatures_equal: JSON.stringify(beforeObservedSignatures) === JSON.stringify(afterObservedSignatures),
    valid: true,
  };
  persistence.ordered_binding_keys = bindingKeys;
  persistence.cover_count_after_reload = preflightValue.coverUpload ? 1 : 0;
  persistence.cover_before_reload = coverEvidence(preflightValue.coverUpload, undefined, 0);
  persistence.cover_after_reload = coverEvidence(preflightValue.coverUpload);
  persistence.cover_signatures_exact = true;
  persistence.cover_pre_post_hamming_distance = preflightValue.coverUpload ? 0 : null;
  persistence.content_before_reload = {
    ...strictPreReloadContent(),
    nativeMediaNodesFound: preflightValue.expectedBodyImages,
    verifiedMediaBindingKeys: bindingKeys,
  };
  return result;
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  finish(code: number, stdout = '', stderr = ''): void {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    this.exitCode = code;
    queueMicrotask(() => this.emit('close', code));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', null));
    return true;
  }
}

interface MemoryFile {
  text: string;
  mtimeMs: number;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function harness(
  onSpawn: (child: FakeChild, args: string[], call: number) => void,
): {
  dependencies: Partial<XArticleUploaderDependencies>;
  files: Map<string, MemoryFile>;
  calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>;
  chmods: Array<[string, number]>;
  privateCreates: string[];
  privateWrites: Array<[string, string]>;
} {
  const cookieText = JSON.stringify([
    { name: 'auth_token', value: 'secret-one', domain: '.x.com' },
    { name: 'ct0', value: 'secret-two', domain: 'x.com' },
  ]);
  const files = new Map<string, MemoryFile>([
    ['/tmp/cookies.json', { text: cookieText, mtimeMs: 9_000 }],
    ['/tmp/prepared.md', { text: prepared().rewrittenMarkdown, mtimeMs: 9_000 }],
  ]);
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const chmods: Array<[string, number]> = [];
  const privateCreates: string[] = [];
  const privateWrites: Array<[string, string]> = [];
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], options });
    queueMicrotask(() => onSpawn(child, args, calls.length));
    return child as unknown as ChildProcess;
  }) as XArticleUploaderDependencies['spawn'];
  return {
    files,
    calls,
    chmods,
    privateCreates,
    privateWrites,
    dependencies: {
      spawn,
      createPrivateFile: async filePath => {
        privateCreates.push(filePath);
        if (files.has(filePath)) throw new Error('EEXIST');
        files.set(filePath, { text: '', mtimeMs: 10_000 });
      },
      fileExists: async filePath => files.has(filePath),
      readText: async filePath => {
        const file = files.get(filePath);
        if (!file) throw new Error('missing');
        return file.text;
      },
      readBytes: async filePath => {
        const file = files.get(filePath);
        if (!file) throw new Error('missing');
        return Buffer.from(file.text, 'utf8');
      },
      writeTextPrivate: async (filePath, text) => {
        privateWrites.push([filePath, text]);
        files.set(filePath, { text, mtimeMs: 10_100 });
      },
      stat: async filePath => {
        const file = files.get(filePath);
        if (!file) throw new Error('missing');
        return { isFile: true, size: Buffer.byteLength(file.text), mtimeMs: file.mtimeMs, mode: 0o600 };
      },
      chmod: async (filePath, mode) => {
        chmods.push([filePath, mode]);
      },
      mkdtemp: async () => '/tmp/upload-unique',
      now: () => 10_000,
      tempDirectory: () => '/tmp',
    },
  };
}

function uploader(dependencies: Partial<XArticleUploaderDependencies>): XArticleLocalUploader {
  return new XArticleLocalUploader({
    pythonCommand: 'python3',
    cookiesPath: '/tmp/cookies.json',
    runtime,
    dependencies,
    authorizeCookieMutation: async () => undefined,
    commitCanonicalCookies: text => commitTestCookies(dependencies, text),
  });
}

function autoExportUploader(
  dependencies: Partial<XArticleUploaderDependencies>,
): XArticleLocalUploader {
  return new XArticleLocalUploader({
    pythonCommand: 'python3',
    cookiesPath: '/tmp/cookies.json',
    autoExportCookiesWhenMissing: true,
    runtime,
    dependencies,
    authorizeCookieMutation: async () => undefined,
    commitCanonicalCookies: text => commitTestCookies(dependencies, text),
  });
}

async function commitTestCookies(
  dependencies: Partial<XArticleUploaderDependencies>,
  text: string,
): Promise<{ path: string; cookieCount: number }> {
  if (!dependencies.writeTextPrivate) throw new Error('missing private writer');
  await dependencies.writeTextPrivate('/tmp/cookies.json', text);
  await dependencies.chmod?.('/tmp/cookies.json', 0o600);
  const parsed = JSON.parse(text) as unknown[];
  return { path: '/tmp/cookies.json', cookieCount: parsed.length };
}

function successfulResultHarness(result: Record<string, unknown>) {
  const state = harness((child, args) => {
    state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
    state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
    state.files.set(option(args, '--result-json'), {
      mtimeMs: 10_100,
      text: JSON.stringify(result),
    });
    child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
  });
  return state;
}

describe('X Article local uploader', () => {
  test.each(anchorNormalizationVectors.normalization_vectors)(
    'matches the shared Python/TypeScript anchor vector: $name',
    (vector) => {
      expect(normalizeXArticleVisibleAnchor(vector.source)).toBe(vector.normalized_source);
      expect(normalizeXArticleVisibleDomAnchor(vector.actual)).toBe(vector.normalized_actual);
      expect(xArticleVisibleAnchorsMatch(vector.source, vector.actual)).toBe(vector.matches);
    },
  );

  test('matches every shared Python/TypeScript media binding vector', () => {
    for (const vector of anchorNormalizationVectors.binding_vectors) {
      expect(computeXArticleMediaBindingKey(
        vector.source_signature,
        vector.occurrence,
        vector.anchor,
        vector.dom_order,
      )).toBe(vector.binding_key);
    }
  });

  test('can compare the repository fixture with an explicitly supplied Skill fixture', () => {
    const explicitFixture = process.env.AILU_X_ARTICLE_ANCHOR_FIXTURE?.trim();
    if (!explicitFixture || !existsSync(explicitFixture)) return;
    expect(JSON.parse(readFileSync(explicitFixture, 'utf8'))).toEqual(anchorNormalizationVectors);
  });

  test('matches Markdown anchors by visible semantics and only permits a DOM prefix', () => {
    const expectedAnchor = '这是一段专门用于测试的**合成锚点文本**，其中包含可见格式和连续图片定位语义。';
    const actualAnchor = '上一行的合成前缀。 这是一段专门用于测试的合成锚点文本，其中包含可见格式和连续图片定位语义。';

    expect(xArticleVisibleAnchorsMatch(expectedAnchor, actualAnchor)).toBe(true);
    expect(xArticleVisibleAnchorsMatch('正确锚点', '前缀 正确锚点 后缀')).toBe(false);
    expect(xArticleVisibleAnchorsMatch('正确锚点', '完全不同的段落')).toBe(false);
  });

  test('normalizes visible Markdown formatting without changing code or escaped literals', () => {
    expect(normalizeXArticleVisibleAnchor('**粗体** __粗体二__ *斜体* _斜体二_ ~~删除~~'))
      .toBe('粗体 粗体二 斜体 斜体二 删除');
    expect(normalizeXArticleVisibleAnchor('**同文**')).toBe('同文');
    expect(normalizeXArticleVisibleAnchor('__同文__')).toBe('同文');
    expect(normalizeXArticleVisibleAnchor('[同文](https://a.example)')).toBe('同文');
    expect(normalizeXArticleVisibleAnchor('[同文](https://a.example/path_(v2))')).toBe('同文');
    expect(normalizeXArticleVisibleAnchor('[嵌套 [标签]](https://a.example)')).toBe('嵌套 [标签]');
    expect(normalizeXArticleVisibleAnchor('[同文][ref]')).toBe('同文');
    expect(normalizeXArticleVisibleAnchor('[同文][]')).toBe('同文');
    expect(normalizeXArticleVisibleAnchor('<https://a.example/path>')).toBe('https://a.example/path');
    expect(normalizeXArticleVisibleAnchor('<me@example.com>')).toBe('me@example.com');
    expect(normalizeXArticleVisibleAnchor('`**literal**`')).toBe('**literal**');
    expect(normalizeXArticleVisibleAnchor('` code `')).toBe('code');
    expect(normalizeXArticleVisibleAnchor('` **literal** &copy; `')).toBe('**literal** &copy;');
    expect(normalizeXArticleVisibleAnchor('Cafe\u0301')).toBe('Café');
    expect(normalizeXArticleVisibleAnchor('这是\\*字面星号\\*')).toBe('这是*字面星号*');
    expect(normalizeXArticleVisibleAnchor('&copy; &NotEqualTilde;')).toBe('© ≂̸');
    expect(normalizeXArticleVisibleAnchor('空格&nbsp;测试 &#169; &#x1F43C;')).toBe('空格 测试 © 🐼');
    expect(normalizeXArticleVisibleAnchor('实体 &CounterClockwiseContourIntegral; &zzzz;'))
      .toBe('实体 ∳ &zzzz;');
    expect(normalizeXArticleVisibleAnchor('\\&copy;')).toBe('&copy;');
    expect(normalizeXArticleVisibleAnchor('Cafe\u0301 A\u200b\u200c\u200d\u2060\ufeffB')).toBe('Café AB');
    expect(normalizeXArticleVisibleAnchor('> **引用锚点**')).toBe('引用锚点');
    expect(normalizeXArticleVisibleAnchor('A \\| B 和 \\`literal\\`')).toBe('A | B 和 `literal`');
    expect(xArticleVisibleAnchorsMatch('这是\\*字面星号\\*', '这是*字面星号*')).toBe(true);
    expect(xArticleVisibleAnchorsMatch('`**literal**`', '**literal**')).toBe(true);
    expect(xArticleVisibleAnchorsMatch('&copy;', '©')).toBe(true);
    expect(xArticleVisibleAnchorsMatch('\\&copy;', '&copy;')).toBe(true);
  });

  test('rejects preflight anchors that differ only by Markdown presentation', () => {
    const value = bodyImagePreflight(3);
    value.anchors[0].anchor = '**同文**';
    value.anchors[1].anchor = '中间唯一锚点';
    value.anchors[2].anchor = '[同文](https://a.example)';

    expect(() => validateXArticleVisibleAnchorContract(value)).toThrow('same visible placement anchor');
  });

  test('generates the same canonical media binding key as the Python Skill', () => {
    const value = bodyImagePreflight(1);
    value.anchors[0].anchor = '**同文** &copy; `**literal**`';

    const contract = sourceMediaContract(value, [zeroVisualSignature]);

    expect(contract[0].binding_key).toBe(
      'media-v1-87c7dbb60e55982be3688324f5199a577ee2e5e9460fd93907d3edd4e9e50aee',
    );
    const syntheticSignature = 'visual-dhash-v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const syntheticAnchor = '这是一段专门用于测试的**合成锚点文本**，其中包含可见格式和连续图片定位语义。';
    expect(computeXArticleMediaBindingKey(
      syntheticSignature,
      1,
      syntheticAnchor,
      10,
    ))
      .toBe('media-v1-663ff1c0d30d505c2d16f90110f10e6e3703ec7ab46c218691e56fcbce97164f');
    expect(computeXArticleMediaBindingKey(syntheticSignature, 1, '', 0))
      .toBe('media-v1-f7bd221a921ec51e22fc81c76b5e35c649943fd463e4c17dded4739e873e7dae');
    expect(computeXArticleMediaBindingKey(syntheticSignature, 2, '> 引用锚点', 4))
      .toBe('media-v1-3b794bc320b410b9e4b57a8246b248f5b52b05c364cb140242b4f51f2badc1a7');
  });

  test('allows a consecutive image run to share one visible anchor because DOM order disambiguates it', () => {
    const value = bodyImagePreflight(3);
    value.anchors[0].anchor = '**同文**';
    value.anchors[1].anchor = '[同文](https://a.example)';
    value.anchors[2].anchor = '__同文__';

    expect(() => validateXArticleVisibleAnchorContract(value)).not.toThrow();
  });

  test('allows a contiguous run of body-start images with empty anchors', () => {
    const value = validateXArticlePreflight({
      ...dryRunJson(3),
      anchors: [
        { index: 1, file: 'image-1.png', anchor: '', placement: 'composer-start' },
        { index: 2, file: 'image-2.png', anchor: '', placement: 'composer-start' },
        { index: 3, file: 'image-3.png', anchor: '', placement: 'composer-start' },
      ],
    }, prepared().contentHash);

    expect(() => validateXArticleVisibleAnchorContract(value)).not.toThrow();
  });

  test('rejects a body-start placement after an anchored image', () => {
    expect(() => validateXArticlePreflight({
      ...dryRunJson(2),
      anchors: [
        { index: 1, file: 'image-1.png', anchor: '第一个稳定锚点', placement: 'after-anchor' },
        { index: 2, file: 'image-2.png', anchor: '', placement: 'composer-start' },
      ],
    }, prepared().contentHash)).toThrow('leading image run');
  });

  test('auto-opens only a strictly successful draft', () => {
    expect(shouldAutoOpenXArticleDraft('success', true)).toBe(true);
    expect(shouldAutoOpenXArticleDraft('success', false)).toBe(false);
    expect(shouldAutoOpenXArticleDraft('partial-draft', true)).toBe(false);
    expect(shouldAutoOpenXArticleDraft('failed', true)).toBe(false);
  });

  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('discovers the current .agents Skill before the .codex fallback', () => {
    const discovered = discoverXArticleSkill({
      homeDirectory: '/Users/example',
      fileExists: filePath => filePath.includes('/.agents/') || filePath.includes('/.codex/'),
    });
    expect(discovered.source).toBe('agents-skill');
    expect(discovered.uploadScript).toContain('/.agents/skills/x-article-draft-uploader/');
    expect(discovered.uploadScript).not.toContain('/plugins/');
  });

  test('rejects an explicit legacy-style scripts directory without the current Skill boundary', () => {
    expect(() => discoverXArticleSkill({
      uploadScriptPath: '/vault/.obsidian/plugins/x-article-in-obsidian/scripts/upload_markdown_to_x_article.py',
      fileExists: () => true,
    })).toThrow('incomplete');
  });

  test('strictly parses dry-run JSON and binds it to the prepared Markdown hash', async () => {
    const state = harness(child => child.finish(0, JSON.stringify(dryRunJson())));
    const result = await uploader(state.dependencies).preflight(prepared());

    expect(result).toMatchObject({
      title: 'Prepared title',
      coverUpload: false,
      coverMissing: true,
      expectedBodyImages: 0,
      expectedTables: 0,
      totalMedia: 0,
      preparedContentHash: prepared().contentHash,
    });
    expect(state.calls[0].command).toBe('python3');
    expect(state.calls[0].args.slice(0, 2)).toEqual(['-u', runtime.uploadScript]);
    expect(state.calls[0].args).toContain('--dry-run');
    expect(state.calls[0].options.shell).toBe(false);
  });

  test('allows 25 body images plus one separate cover', () => {
    const result = validateXArticlePreflight(dryRunJson(25, true));
    expect(result.totalMedia).toBe(26);
    expect(result.errors).not.toContainEqual(expect.objectContaining({ type: 'body_media_limit_exceeded' }));
  });

  test('blocks the 26th body image regardless of cover and avoids duplicate Skill errors', () => {
    const withoutCover = validateXArticlePreflight(dryRunJson(26, false));
    expect(withoutCover.totalMedia).toBe(26);
    const bodyLimitError = withoutCover.errors.find(error => error.type === 'body_media_limit_exceeded');
    expect(bodyLimitError?.details).toMatchObject({
      bodyMedia: 26,
      maximum: 25,
      coverSeparate: true,
    });

    const withSkillError = validateXArticlePreflight({
      ...dryRunJson(26, true),
      preflight: {
        warnings: [],
        errors: [{
          type: 'body_media_limit_exceeded',
          message: 'Skill already blocked the 26th body image.',
          expected_body_images: 26,
          maximum: 25,
          cover_separate: true,
        }],
      },
    });
    expect(withSkillError.totalMedia).toBe(27);
    expect(withSkillError.errors.filter(error => error.type === 'body_media_limit_exceeded')).toHaveLength(1);
  });

  test('accepts individual empty table cells while rejecting a completely empty table', () => {
    const withBlankCell = validateXArticlePreflight({
      ...dryRunJson(),
      expected_tables: 1,
      tables: [{
        index: 1,
        rows: 2,
        columns: 2,
        marker: 'X_TABLE_MARKER_001_DO_NOT_EDIT',
        normalized_matrix: [['标题', ''], ['内容', '值']],
      }],
    });
    expect(withBlankCell.tables[0].normalizedMatrix).toEqual([['标题', ''], ['内容', '值']]);

    expect(() => validateXArticlePreflight({
      ...dryRunJson(),
      expected_tables: 1,
      tables: [{
        index: 1,
        rows: 2,
        columns: 2,
        marker: 'X_TABLE_MARKER_001_DO_NOT_EDIT',
        normalized_matrix: [['', ''], ['', '']],
      }],
    })).toThrow('invalid or empty normalized matrices');
  });

  test('requires the three-to-five checkpoint and exact SHA-256 contract', () => {
    expect(() => validateXArticlePreflight({
      ...dryRunJson(),
      content_checkpoints: ['only-one'],
    })).toThrow('between three and five');
    expect(validateXArticlePreflight({
      ...dryRunJson(),
      content_checkpoints: ['Prepared', 'Body', 'sentence.'],
    }).contentCheckpoints).toHaveLength(3);
    expect(() => validateXArticlePreflight({
      ...dryRunJson(),
      expected_compact_sha256: 'not-a-sha256',
    })).toThrow('lowercase SHA-256');
    expect(() => validateXArticlePreflight({
      ...dryRunJson(),
      compact_length_unit: 'utf16_code_units',
    })).toThrow('unicode_code_points');
    expect(validateXArticlePreflight({
      ...dryRunJson(),
      content_checkpoints: ['😀'.repeat(32), 'Body', 'sentence.'],
      expected_compact_length: 45,
    }).contentCheckpoints[0]).toBe('😀'.repeat(32));
    expect(() => validateXArticlePreflight({
      ...dryRunJson(),
      content_checkpoints: ['😀'.repeat(33), 'Body', 'sentence.'],
      expected_compact_length: 46,
    })).toThrow('at most 32 characters');
  });

  test('blocks body dividers while ignoring frontmatter, fences, and table separators', () => {
    const markdown = [
      '---',
      'formatter:',
      '  title: Test',
      '---',
      '# Test',
      '***',
      '',
      '```md',
      '___',
      '```',
      '',
      '| A | B |',
      '| --- | --- |',
    ].join('\n');
    expect(findUnsupportedXArticleDividers(markdown)).toEqual([{ line: 6, text: '***' }]);
    expect(findUnsupportedXArticleDividers('---\n# Not frontmatter')).toEqual([{ line: 1, text: '---' }]);
    const checked = addPreparedMarkdownPreflightErrors(preflight(), markdown);
    expect(checked.errors).toContainEqual(expect.objectContaining({ type: 'unsupported_divider' }));
  });

  test('blocks raw HTML outside fences while allowing Markdown autolinks', () => {
    const markdown = [
      '# Test',
      '<https://example.com/reference>',
      '<user@example.com>',
      '<img src="https://tracker.example/pixel.png">',
      '<iframe src="https://example.com"></iframe>',
      '<img',
      '  src="https://tracker.example/multiline.png">',
      '<source',
      '  srcset="https://tracker.example/multiline.webp">',
      '<!-- remote',
      'comment -->',
      '```html',
      '<img',
      '  src="https://safe-inside-code.example/image.png">',
      '```',
    ].join('\n');
    expect(findUnsupportedXArticleRawHtml(markdown)).toEqual([
      { line: 4, tag: 'img', text: '<img src="https://tracker.example/pixel.png">' },
      { line: 5, tag: 'iframe', text: '<iframe src="https://example.com">' },
      { line: 5, tag: 'iframe', text: '</iframe>' },
      { line: 6, tag: 'img', text: '<img src="https://tracker.example/multiline.png">' },
      { line: 8, tag: 'source', text: '<source srcset="https://tracker.example/multiline.webp">' },
      { line: 10, tag: 'comment', text: '<!-- remote comment -->' },
    ]);
    const checked = addPreparedMarkdownPreflightErrors(preflight(), markdown);
    expect(checked.errors).toContainEqual(expect.objectContaining({ type: 'unsupported_raw_html' }));
  });

  test('uses CommonMark fence opening and closing rules for raw HTML preflight', () => {
    const markdown = [
      '```invalid`info',
      '<img src="https://tracker.example/after-invalid-opener.png">',
      '```',
      '<img src="https://safe-inside-code.example/image.png">',
      '```not-a-close',
      '```',
      '<source src="https://tracker.example/after-valid-close.webp">',
      '~~~html',
      '<img src="https://safe-inside-tilde.example/image.png">',
      '~~~',
    ].join('\n');

    expect(findUnsupportedXArticleRawHtml(markdown)).toEqual([
      {
        line: 2,
        tag: 'img',
        text: '<img src="https://tracker.example/after-invalid-opener.png">',
      },
      {
        line: 7,
        tag: 'source',
        text: '<source src="https://tracker.example/after-valid-close.webp">',
      },
    ]);
  });

  test('blocks reference-style images instead of silently uploading them as text', () => {
    const markdown = [
      '# Test',
      '![Full][asset]',
      '![Collapsed][]',
      '![Shortcut]',
      '![Escaped \\] alt][escaped]',
      '![Nested [alt]][nested]',
      '![Cross',
      'line alt][cross]',
      '![Escaped ref][ref\\]label]',
      '![Cross ref][ref',
      'label]',
      '![Inline](inline.png)',
      '![[wiki.png]]',
      '[ordinary link][asset]',
      '',
      '[asset]: images/full.png',
      '[collapsed]: images/collapsed.png',
      '[shortcut]: images/shortcut.png',
      '[escaped]: images/escaped.png',
      '[nested]: images/nested.png',
      '[cross]: images/cross.png',
      '[ref\\]label]: images/escaped-ref.png',
      '[ref',
      'label]: images/cross-ref.png',
      '```md',
      '![Code][inside]',
      '[inside]: code.png',
      '```',
    ].join('\n');

    expect(findUnsupportedXArticleReferenceImages(markdown)).toEqual([
      { line: 2, label: 'asset', text: '![Full][asset]' },
      { line: 3, label: 'collapsed', text: '![Collapsed][]' },
      { line: 4, label: 'shortcut', text: '![Shortcut]' },
      { line: 5, label: 'escaped', text: '![Escaped \\] alt][escaped]' },
      { line: 6, label: 'nested', text: '![Nested [alt]][nested]' },
      { line: 7, label: 'cross', text: '![Cross\nline alt][cross]' },
      { line: 9, label: 'ref]label', text: '![Escaped ref][ref\\]label]' },
      { line: 10, label: 'ref label', text: '![Cross ref][ref\nlabel]' },
    ]);
    const checked = addPreparedMarkdownPreflightErrors(preflight(), markdown);
    expect(checked.errors).toContainEqual(expect.objectContaining({
      type: 'unsupported_reference_image',
    }));
  });

  test('fails closed for unresolved shortcut image syntax but keeps Obsidian image embeds', () => {
    expect(findUnsupportedXArticleReferenceImages([
      '# Test',
      '![Unresolved shortcut]',
      '![[images/local.png]]',
      '\\![Escaped literal]',
    ].join('\n'))).toEqual([
      { line: 2, label: 'unresolved shortcut', text: '![Unresolved shortcut]' },
    ]);
  });

  test('requires atomic result and URL artifacts for success while retaining diagnostics', async () => {
    const state = harness((child, args) => {
      const resultPath = option(args, '--result-json');
      const urlPath = option(args, '--url-output');
      const screenshotPath = option(args, '--screenshot');
      state.files.set(urlPath, { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(screenshotPath, { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(resultPath, {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult()),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    expect(outcome.draftUrl).toBe(draftUrl);
    expect(outcome.artifacts?.directory).toBe('/tmp/upload-unique');
    expect(outcome.artifacts?.log).toBe('/tmp/upload-unique/run.log');
    expect(state.files.get('/tmp/upload-unique/run.log')?.text).toContain('"exitCode": 0');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).toEqual(expect.arrayContaining([
      '--result-json', '/tmp/upload-unique/result.json',
      '--url-output', '/tmp/upload-unique/draft-url.txt',
      '--screenshot', '/tmp/upload-unique/final.png',
    ]));
    expect(state.calls[0].options.shell).toBe(false);
    expect(state.chmods).not.toContainEqual(['/tmp/cookies.json', 0o600]);
    expect(state.chmods).toContainEqual(['/tmp/upload-unique', 0o700]);
    expect(state.chmods).toEqual(expect.arrayContaining([
      ['/tmp/upload-unique/result.json', 0o600],
      ['/tmp/upload-unique/draft-url.txt', 0o600],
      ['/tmp/upload-unique/final.png', 0o600],
      ['/tmp/upload-unique/run.log', 0o600],
    ]));
  });

  test('accepts a truncated stdout tail when marker, URL artifact, and strict result JSON agree', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult()),
      });
      child.finish(0, `${'x'.repeat(300_000)}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'success', draftUrl });
    expect(state.files.get('/tmp/upload-unique/run.log')?.text).toContain('"truncated": true');
  });

  test('rejects the truncated-tail fallback when result JSON names a different draft', async () => {
    const differentDraftUrl = 'https://x.com/compose/articles/edit/9999999999';
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult({ draft_url: differentDraftUrl })),
      });
      child.finish(0, `${'x'.repeat(300_000)}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('内容一致性校验失败');
  });

  test('downgrades a missing stdout URL when the atomic URL and result agree', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult()),
      });
      child.finish(0, 'RESULT_OK True\n');
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('stdout draft URL');
    }
  });

  test('downgrades a missing stdout marker when atomic artifacts pass strict verification', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult()),
      });
      child.finish(0, 'x'.repeat(300_000));
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('stdout success marker');
      expect(outcome.result.verificationWarnings.join(' ')).toContain('stdout draft URL');
    }
  });

  test('downgrades per-file chmod failure when the artifact directory is already private', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult()),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });
    const originalChmod = state.dependencies.chmod!;
    const outcome = await uploader({
      ...state.dependencies,
      chmod: async (filePath, mode) => {
        if (filePath.endsWith('/final.png')) throw new Error('simulated chmod failure');
        await originalChmod(filePath, mode);
      },
    }).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('final.png');
      expect(outcome.result.verificationWarnings.join(' ')).toContain('directory remains private');
    }
  });

  test('downgrades a missing final screenshot after atomic reload evidence passes', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: `${draftUrl}\n`, mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult()),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('diagnostic screenshot');
    }
  });

  test('accepts twelve native tables only with complete visible matrices before and after reload', async () => {
    const tablePreflight = multiTablePreflight();
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictMultiTableResult()),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: tablePreflight });

    expect(outcome).toMatchObject({ status: 'success', draftUrl });
    if (outcome.status === 'success') expect(outcome.result.tableCount).toBe(12);
  });

  test('rejects the prior failure shape where eleven of twelve visible tables are blank', async () => {
    const tablePreflight = multiTablePreflight();
    const result = strictMultiTableResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const postReload = persistence.tables_after_reload as Record<string, unknown>[];
    postReload.slice(1).forEach(table => {
      table.visible_matrix = [['', ''], ['', '']];
      table.visible_non_empty_cells = 0;
      table.visible_matrix_matches = true;
      table.readback_matches = true;
    });
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(result),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: tablePreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('post_reload table 2 did not persist exactly');
  });

  test('rejects table matrices that agree with each other but not with Markdown preflight', async () => {
    const tablePreflight = multiTablePreflight();
    const result = strictMultiTableResult();
    const forged = [['Forged', 'Matrix'], ['Still', 'Visible']];
    const inserted = result.inserted_tables as Record<string, unknown>[];
    inserted[0].expected_matrix = forged;
    inserted[0].visible_matrix = forged;
    const persistence = result.persistence_evidence as Record<string, unknown>;
    for (const phase of ['tables_before_reload', 'tables_after_reload'] as const) {
      const evidence = persistence[phase] as Record<string, unknown>[];
      evidence[0].expected_matrix = forged;
      evidence[0].visible_matrix = forged;
    }
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), { mtimeMs: 10_100, text: JSON.stringify(result) });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: tablePreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('post_reload table 1 did not persist exactly');
  });

  test('binds hosted body-media identities across reload and keeps cover totals separate', async () => {
    const mediaPreflight = bodyImagePreflight(2, true);
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictBodyMediaResult(mediaPreflight)),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.bodyMediaCount).toBe(2);
      expect(outcome.result.mediaCount).toBe(3);
      expect(outcome.result.coverPersisted).toBe(true);
    }
  });

  test('downgrades an invalid pre-reload body snapshot after exact final reload', async () => {
    const result = strictUploadResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    persistence.content_before_reload = {};
    persistence.content_before_reload_verified = false;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('pre-reload body observation');
    }
  });

  test('downgrades insertion-time and pre-reload table observations after exact final reload', async () => {
    const tablePreflight = multiTablePreflight(2);
    const result = strictMultiTableResult(2);
    result.inserted_tables = [];
    const persistence = result.persistence_evidence as Record<string, unknown>;
    persistence.tables_before_reload = [];
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: tablePreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      const warnings = outcome.result.verificationWarnings.join(' ');
      expect(warnings).toContain('insertion-time table readback');
      expect(warnings).toContain('pre-reload table observation');
    }
  });

  test('downgrades an invalid pre-reload cover observation after exact final reload', async () => {
    const coverPreflight = bodyImagePreflight(0, true);
    const result = strictBodyMediaResult(coverPreflight);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    persistence.cover_before_reload = {};
    persistence.cover_signature_persisted = false;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: coverPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('pre-reload cover observation');
    }
  });

  test('downgrades invalid pre-reload media and phase summaries after exact final reload', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight);
    result.media_bindings_persisted = false;
    const persistence = result.persistence_evidence as Record<string, unknown>;
    persistence.media_before_reload = {};
    persistence.media_phase_persistence = {};
    persistence.media_signatures_persisted = false;
    persistence.media_bindings_persisted = false;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      const warnings = outcome.result.verificationWarnings.join(' ');
      expect(warnings).toContain('pre-reload body-media observation');
      expect(warnings).toContain('media phase comparison');
    }
  });

  test('downgrades malformed and ambiguous transient paste evidence after exact final reload', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight);
    const inserted = (result.inserted as Record<string, unknown>[])[0];
    inserted.observed_signature = 'transient-unreadable-signature';
    inserted.signature_hamming_distance = 999;
    inserted.paste_binding = {
      identity_candidate_indices: [0, 1],
      matching_candidate_indices: [],
      valid: false,
    };
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('transient paste evidence');
    }
  });

  test('downgrades a missing insertion-stage image log after exact final reload', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight);
    result.inserted = [];
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('insertion-stage image records');
    }
  });

  test('rejects a wrong post-reload cover even when cover summary flags stay true', async () => {
    const coverPreflight = bodyImagePreflight(0, true);
    const result = strictBodyMediaResult(coverPreflight);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.cover_after_reload as Record<string, unknown>;
    const wrongSignature = `visual-dhash-v1:${'d'.repeat(64)}`;
    after.ordered_signatures = [wrongSignature];
    (after.items as Record<string, unknown>[])[0].sourceSignature = wrongSignature;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: coverPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('post-reload cover fingerprint');
  });

  test('accepts a formatted synthetic anchor after X joins a preceding DOM line', async () => {
    const expectedAnchor = '这是一段专门用于测试的**合成锚点文本**，其中包含可见格式和连续图片定位语义。';
    const actualAnchor = '上一行的合成前缀。 这是一段专门用于测试的合成锚点文本，其中包含可见格式和连续图片定位语义。';
    const mediaPreflight = validateXArticlePreflight({
      ...dryRunJson(1),
      anchors: [{ index: 1, file: 'synthetic-image.png', anchor: expectedAnchor }],
    }, prepared().contentHash);
    const result = strictBodyMediaResult(mediaPreflight);
    const inserted = (result.inserted as Record<string, unknown>[])[0];
    inserted.anchor_used = actualAnchor;
    const pasteBinding = inserted.paste_binding as Record<string, unknown>;
    pasteBinding.anchor_before = actualAnchor;
    pasteBinding.anchor_matches = false;
    const persistence = result.persistence_evidence as Record<string, unknown>;
    for (const phase of ['media_before_reload', 'media_after_reload'] as const) {
      const evidence = persistence[phase] as Record<string, unknown>;
      const item = (evidence.items as Record<string, unknown>[])[0];
      item.anchor_before = actualAnchor;
      item.anchor_matches = false;
    }
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings).toEqual(expect.arrayContaining([
        expect.stringContaining('transient paste evidence'),
      ]));
    }
  });

  test('accepts deferred transient anchors for a leading composer-start image run after exact reload', async () => {
    const mediaPreflight = validateXArticlePreflight({
      ...dryRunJson(3),
      anchors: [
        { index: 1, file: 'image-1.png', anchor: '', placement: 'composer-start' },
        { index: 2, file: 'image-2.png', anchor: '', placement: 'composer-start' },
        { index: 3, file: 'image-3.png', anchor: '后续正文的稳定锚点', placement: 'after-anchor' },
      ],
    }, prepared().contentHash);
    const result = strictBodyMediaResult(mediaPreflight);
    const inserted = result.inserted as Record<string, unknown>[];
    for (const item of inserted.slice(0, 2)) {
      item.anchor_used = 'X_MEDIA_START_MARKER_DO_NOT_EDIT';
      const pasteBinding = item.paste_binding as Record<string, unknown>;
      pasteBinding.anchor_before = 'X_MEDIA_START_MARKER_DO_NOT_EDIT';
      pasteBinding.candidate_indices = [];
      pasteBinding.matching_candidate_indices = [];
      pasteBinding.anchor_matches = false;
      pasteBinding.valid = false;
      pasteBinding.eligible_for_final_verification = true;
    }
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const before = persistence.media_before_reload as Record<string, unknown>;
    for (const item of (before.items as Record<string, unknown>[]).slice(0, 2)) {
      item.anchor_before = 'X_MEDIA_START_MARKER_DO_NOT_EDIT';
      item.anchor_matches = false;
    }
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('transient');
      expect(outcome.result.verificationWarnings.join(' ')).toContain('pre-reload body-media');
    }
  });

  test('rejects a composer-start image when final reload shows body text before it', async () => {
    const mediaPreflight = validateXArticlePreflight({
      ...dryRunJson(1),
      anchors: [{ index: 1, file: 'image-1.png', anchor: '', placement: 'composer-start' }],
    }, prepared().contentHash);
    const result = strictBodyMediaResult(mediaPreflight);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    const afterItem = (after.items as Record<string, unknown>[])[0];
    afterItem.anchor_before = '这段正文错误地出现在图片之前';
    afterItem.anchor_matches = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('post_reload body image 1');
  });

  test('accepts repeated local source signatures by occurrence, anchor, and DOM order', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature, zeroVisualSignature],
    });
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      const contract = outcome.result.raw.source_media_contract as Record<string, unknown>[];
      expect(contract.map(item => item.source_signature)).toEqual([
        zeroVisualSignature,
        zeroVisualSignature,
      ]);
      expect(contract.map(item => item.occurrence)).toEqual([1, 2]);
      expect(new Set(contract.map(item => item.binding_key)).size).toBe(2);
    }
  });

  test('rejects swapped images when two distinct sources are both inside the Hamming radius', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const closeSource = visualSignatureWithBits(31);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature, closeSource],
      beforeObservedSignatures: [closeSource, zeroVisualSignature],
      afterObservedSignatures: [closeSource, zeroVisualSignature],
    });
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('source-assignment evidence was inconsistent');
  });

  test('accepts a real post-reload dHash sentinel within the calibrated 64-bit radius', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const beforeSignature = visualSignatureWithBits(1);
    const postReloadSentinel = visualSignatureWithBits(64);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature],
      beforeObservedSignatures: [beforeSignature],
      afterObservedSignatures: [postReloadSentinel],
    });
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      const persistence = outcome.result.raw.persistence_evidence as Record<string, unknown>;
      const after = persistence.media_after_reload as Record<string, unknown>;
      const items = after.items as Record<string, unknown>[];
      expect(after.phase_sentinel).toBe('post_reload');
      expect(items[0].observed_signature).toBe(postReloadSentinel);
      expect(items[0].signature_hamming_distance).toBe(64);
    }
  });

  test('accepts an initial inserted dHash sentinel at the calibrated 64-bit boundary', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const initialSentinel = visualSignatureWithBits(64);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature],
      beforeObservedSignatures: [initialSentinel],
      afterObservedSignatures: [initialSentinel],
    });
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      const inserted = outcome.result.raw.inserted as Record<string, unknown>[];
      expect(inserted[0].signature_hamming_distance).toBe(64);
      expect(inserted[0].signature_match).toBe(true);
    }
  });

  test('accepts the bounded adaptive production shape at distance 71 with a 20-bit margin', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const expectedSource = visualSignatureWithBits(71);
    const secondSource = visualSignatureWithBits(91);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [expectedSource, secondSource],
      beforeObservedSignatures: [zeroVisualSignature, secondSource],
      afterObservedSignatures: [zeroVisualSignature, secondSource],
    });
    const inserted = result.inserted as Record<string, unknown>[];
    inserted[0].signature_match = true;
    applyAdaptiveVisualEvidence(inserted[0].paste_binding as Record<string, unknown>);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    for (const phase of ['media_before_reload', 'media_after_reload'] as const) {
      const evidence = persistence[phase] as Record<string, unknown>;
      const item = (evidence.items as Record<string, unknown>[])[0];
      applyAdaptiveVisualEvidence(item);
    }
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
  });

  test('accepts a post-reload body image at dHash distance 120 via exact sample consensus', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const transformed = visualSignatureWithBits(120);
    const distractor = visualSignatureWithBits(256);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature, distractor],
      beforeObservedSignatures: [zeroVisualSignature, distractor],
      afterObservedSignatures: [transformed, distractor],
    });
    const contract = result.source_media_contract as Record<string, unknown>[];
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    applySampleConsensusVisualEvidence(
      (after.items as Record<string, unknown>[])[0],
      contract,
      0,
    );
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
  });

  test('allows sample identity to correct a dHash nearest-source disagreement', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const distractor = visualSignatureWithBits(256);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature, distractor],
      beforeObservedSignatures: [zeroVisualSignature, distractor],
      afterObservedSignatures: [distractor, distractor],
    });
    const contract = result.source_media_contract as Record<string, unknown>[];
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    const item = (after.items as Record<string, unknown>[])[0];
    item.source_ambiguous = true;
    applySampleConsensusVisualEvidence(item, contract, 0);
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
  });

  test('accepts sample correlation epsilon above one but rejects a materially invalid correlation', async () => {
    const runWithCorrelation = async (correlation: number) => {
      const mediaPreflight = bodyImagePreflight(2);
      const transformed = visualSignatureWithBits(120);
      const distractor = visualSignatureWithBits(256);
      const result = strictBodyMediaResult(mediaPreflight, {
        sourceSignatures: [zeroVisualSignature, distractor],
        beforeObservedSignatures: [zeroVisualSignature, distractor],
        afterObservedSignatures: [transformed, distractor],
      });
      const contract = result.source_media_contract as Record<string, unknown>[];
      const persistence = result.persistence_evidence as Record<string, unknown>;
      const after = persistence.media_after_reload as Record<string, unknown>;
      applySampleConsensusVisualEvidence(
        (after.items as Record<string, unknown>[])[0],
        contract,
        0,
        { correlation },
      );
      const state = successfulResultHarness(result);
      return uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });
    };

    await expect(runWithCorrelation(1 + Number.EPSILON)).resolves.toMatchObject({ status: 'success' });
    await expect(runWithCorrelation(1.01)).resolves.toMatchObject({
      status: 'partial-draft',
      draftUrl,
      result: null,
    });
  });

  test('rejects forged sample consensus thresholds and match policy', async () => {
    const runWithMutation = async (mutate: (item: Record<string, unknown>) => void) => {
      const mediaPreflight = bodyImagePreflight(2);
      const transformed = visualSignatureWithBits(120);
      const distractor = visualSignatureWithBits(256);
      const result = strictBodyMediaResult(mediaPreflight, {
        sourceSignatures: [zeroVisualSignature, distractor],
        beforeObservedSignatures: [zeroVisualSignature, distractor],
        afterObservedSignatures: [transformed, distractor],
      });
      const contract = result.source_media_contract as Record<string, unknown>[];
      const persistence = result.persistence_evidence as Record<string, unknown>;
      const after = persistence.media_after_reload as Record<string, unknown>;
      const item = (after.items as Record<string, unknown>[])[0];
      applySampleConsensusVisualEvidence(item, contract, 0);
      mutate(item);
      const state = successfulResultHarness(result);
      return uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });
    };

    await expect(runWithMutation(item => {
      item.rgb_mean_absolute_error = 0.13;
    })).resolves.toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    await expect(runWithMutation(item => {
      item.match_policy = 'adaptive-unique-nearest';
    })).resolves.toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    await expect(runWithMutation(item => {
      item.expected_source_sample_is_unique_nearest = false;
    })).resolves.toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('accepts a post-reload cover at dHash distance 120 via exact sample consensus', async () => {
    const runCover = async (mutate?: (cover: Record<string, unknown>) => void) => {
      const coverPreflight = bodyImagePreflight(0, true);
      const result = strictBodyMediaResult(coverPreflight);
      const transformed = visualSignatureWithBits(120);
      const sourceSignature = zeroVisualSignature;
      const sampleId = createHash('sha256')
        .update('cover-sample', 'utf8')
        .digest('hex')
        .slice(0, 16);
      const sampleContract = [{
        expected_source_sample_id: sampleId,
        source_natural_width: 1_500,
        source_natural_height: 600,
      }];
      const persistence = result.persistence_evidence as Record<string, unknown>;
      const postCover = coverEvidence(true, transformed);
      postCover.source_signature = sourceSignature;
      postCover.source_hamming_distance = 120;
      postCover.signature_hamming_distance = 120;
      postCover.distinct_source_group_count = 1;
      postCover.nearest_source_distance = 120;
      postCover.second_nearest_source_distance = null;
      postCover.nearest_source_margin = null;
      postCover.expected_source_is_unique_nearest = true;
      applySampleConsensusVisualEvidence(postCover, sampleContract, 0);
      postCover.observed_natural_width = 1_500;
      postCover.observed_natural_height = 600;
      mutate?.(postCover);
      persistence.cover_after_reload = postCover;
      persistence.cover_signatures_exact = false;
      persistence.cover_pre_post_hamming_distance = 120;
      const state = successfulResultHarness(result);
      return uploader(state.dependencies).upload(prepared(), { preflight: coverPreflight });
    };

    await expect(runCover()).resolves.toMatchObject({ status: 'success' });
    await expect(runCover(cover => {
      cover.match_policy = 'adaptive-unique-nearest';
    })).resolves.toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('rejects adaptive evidence when the nearest-source margin is below 16 bits', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const expectedSource = visualSignatureWithBits(71);
    const tooCloseSource = visualSignatureWithBits(86);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [expectedSource, tooCloseSource],
      beforeObservedSignatures: [zeroVisualSignature, tooCloseSource],
      afterObservedSignatures: [zeroVisualSignature, tooCloseSource],
    });
    const inserted = result.inserted as Record<string, unknown>[];
    inserted[0].signature_match = true;
    applyAdaptiveVisualEvidence(inserted[0].paste_binding as Record<string, unknown>);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    for (const phase of ['media_before_reload', 'media_after_reload'] as const) {
      const evidence = persistence[phase] as Record<string, unknown>;
      applyAdaptiveVisualEvidence((evidence.items as Record<string, unknown>[])[0]);
    }
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('adaptive visual evidence was inconsistent');
  });

  test('rejects an initial inserted dHash sentinel outside the 64-bit radius', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const outsideSentinel = visualSignatureWithBits(65);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature],
      beforeObservedSignatures: [outsideSentinel],
      afterObservedSignatures: [outsideSentinel],
    });
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('rejects an observed post-reload dHash outside the 64-bit radius', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature],
      afterObservedSignatures: [visualSignatureWithBits(65)],
    });
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('recomputes dHash distance and rejects forged distance/match flags', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight, {
      sourceSignatures: [zeroVisualSignature],
      afterObservedSignatures: [visualSignatureWithBits(65)],
    });
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    const afterItem = (after.items as Record<string, unknown>[])[0];
    afterItem.source_hamming_distance = 0;
    afterItem.signature_hamming_distance = 0;
    afterItem.source_matches = true;
    afterItem.signature_match = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('rejects a changed post-reload binding key even when aggregate flags stay true', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    const afterItem = (after.items as Record<string, unknown>[])[0];
    const forgedKey = `media-v1-${'f'.repeat(64)}`;
    afterItem.identity_key = forgedKey;
    afterItem.binding_key = forgedKey;
    after.ordered_identity_keys = [forgedKey];
    after.ordered_binding_keys = [forgedKey];
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('rejects post-reload binding and DOM order changes', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const result = strictBodyMediaResult(mediaPreflight);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    const items = after.items as Record<string, unknown>[];
    after.items = [items[1], items[0]];
    after.ordered_signatures = [...(after.ordered_signatures as string[])].reverse();
    after.ordered_identity_keys = [...(after.ordered_identity_keys as string[])].reverse();
    after.ordered_binding_keys = [...(after.ordered_binding_keys as string[])].reverse();
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('independently rejects a wrong post-reload image anchor even when the flag is forged true', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const result = strictBodyMediaResult(mediaPreflight);
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const after = persistence.media_after_reload as Record<string, unknown>;
    const afterItems = after.items as Record<string, unknown>[];
    afterItems[1].anchor_before = 'Completely unrelated paragraph';
    afterItems[1].anchor_matches = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('rejects body verification that did not strip exactly the verified media blocks', async () => {
    const mediaPreflight = bodyImagePreflight(2);
    const result = strictBodyMediaResult(mediaPreflight);
    result.mediaStripReliable = false;
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), { mtimeMs: 10_100, text: JSON.stringify(result) });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('exact compact body verification did not match');
  });

  test('downgrades missing DOM binding annotations when post-reload media is exact', async () => {
    const mediaPreflight = bodyImagePreflight(1);
    const result = strictBodyMediaResult(mediaPreflight);
    result.verifiedMediaBindingKeys = [`media-v1-${'e'.repeat(64)}`];
    result.mediaStripReliable = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: mediaPreflight });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('DOM binding annotations');
    }
  });

  test('downgrades a stale autosave mutation epoch after strict reload persistence succeeds', async () => {
    const result = strictUploadResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    persistence.autosave_before_reload = autosaveEvidence('stale-mutation-epoch');
    const autosave = persistence.autosave_before_reload as Record<string, unknown>;
    autosave.epoch_matches = true;
    autosave.verified = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.autosaveVerified).toBe(false);
      expect(outcome.result.verificationWarnings.join(' ')).toContain('save-status UI evidence');
    }
  });

  test('downgrades a stale saved sentinel after strict reload persistence succeeds', async () => {
    const result = strictUploadResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const autosave = persistence.autosave_before_reload as Record<string, unknown>;
    autosave.events = [];
    autosave.relevant_events = [];
    autosave.saving_to_saved_transitions = [];
    autosave.changed_saved_nodes = [];
    autosave.post_mutation_saved_observations = [];
    autosave.verified = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.autosaveVerified).toBe(false);
    }
  });

  test('accepts missing autosave UI observations only after reload persistence is exact', async () => {
    const result = strictUploadResult();
    result.autosave_verified = false;
    result.saveText = '';
    const persistence = result.persistence_evidence as Record<string, unknown>;
    persistence.autosave_verified = false;
    persistence.autosave_before_reload = {};
    persistence.autosave_after_reload = {};
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.persistenceVerified).toBe(true);
      expect(outcome.result.autosaveVerified).toBe(false);
      expect(outcome.result.verificationWarnings).toHaveLength(3);
    }
  });

  test('accepts a same-token saved observation recorded after the final mutation sequence', async () => {
    const result = strictUploadResult();
    result.saveText = '草稿 · 刚刚最后保存';
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const autosave = persistence.autosave_before_reload as Record<string, unknown>;
    const saved = {
      channelKey: 'id:detail-header',
      nodeInstance: 2,
      state: 'saved',
      text: '草稿 · 刚刚最后保存',
      attributes: { state: '', status: '', version: '', busy: '', datetime: '' },
      token: 'saved-token-unchanged',
      sequence: 23,
      observedAt: 10_020,
    };
    autosave.lastMutationAt = 10_005;
    autosave.lastMutationEventCursor = 22;
    autosave.lastMutationSequence = 22;
    autosave.last_mutation_sequence = 22;
    autosave.mutationBaseline = [{
      ...saved,
      nodeInstance: 1,
      sequence: undefined,
      observedAt: undefined,
    }];
    autosave.current = [{ ...saved, sequence: undefined, observedAt: undefined }];
    autosave.events = [saved];
    autosave.relevant_events = [saved];
    autosave.saving_to_saved_transitions = [];
    autosave.changed_saved_nodes = [saved];
    autosave.departure_to_saved_transitions = [];
    autosave.post_mutation_saved_observations = [];
    autosave.saved_state_present = true;
    autosave.verified = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'success', draftUrl });
  });

  test('accepts a same-channel departed-to-saved autosave transition from the real X DOM shape', async () => {
    const result = strictUploadResult();
    result.saveText = '草稿 · 刚刚最后保存';
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const autosave = persistence.autosave_before_reload as Record<string, unknown>;
    const baseline = {
      channelKey: 'id:detail-header',
      nodeInstance: 1,
      state: 'saved',
      text: '草稿 · 刚刚最后保存',
      attributes: { state: '', status: '', version: '', busy: '', datetime: '' },
      token: 'saved-current-token',
    };
    const priorSaved = {
      ...baseline,
      text: '草稿 · 上一次保存 6秒钟 前',
      token: 'saved-aged-token',
      sequence: 65,
      observedAt: 10_010,
    };
    const departed = {
      channelKey: baseline.channelKey,
      nodeInstance: 1,
      state: 'departed',
      text: '',
      attributes: {},
      token: '',
      previousState: 'saved',
      previousText: priorSaved.text,
      previousToken: priorSaved.token,
      sequence: 66,
      observedAt: 10_020,
    };
    const saved = { ...baseline, sequence: 67, observedAt: 10_030 };
    autosave.lastMutationAt = 10_005;
    autosave.lastMutationEventCursor = 64;
    autosave.lastMutationSequence = 64;
    autosave.last_mutation_sequence = 64;
    autosave.mutationBaseline = [baseline];
    autosave.current = [baseline];
    autosave.events = [priorSaved, departed, saved];
    autosave.relevant_events = [priorSaved, departed, saved];
    autosave.saving_to_saved_transitions = [];
    autosave.changed_saved_nodes = [];
    autosave.departure_to_saved_transitions = [{
      channel_key: baseline.channelKey,
      previous_live_sequence: 65,
      previous_live_token: priorSaved.token,
      previous_live_node_instance: 1,
      departure_sequence: 66,
      saved_sequence: 67,
      saved_token: baseline.token,
      saved_node_instance: 1,
    }];
    autosave.post_mutation_saved_observations = [saved];
    autosave.saved_state_present = true;
    autosave.verified = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'success', draftUrl });
  });

  test('downgrades a malformed departed-to-saved UI transition after reload succeeds', async () => {
    const result = strictUploadResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const autosave = persistence.autosave_before_reload as Record<string, unknown>;
    const baseline = autosave.mutationBaseline as Record<string, unknown>[];
    const saved = autosave.current as Record<string, unknown>[];
    const currentSavedToken = typeof saved[0]?.token === 'string' ? saved[0].token : '';
    const departed = {
      channelKey: 'testid:article-save-status',
      nodeInstance: 1,
      state: 'departed',
      text: '',
      attributes: {},
      token: '',
      previousToken: 'forged-other-token',
      sequence: 1,
      observedAt: 10_010,
    };
    const currentSaved = { ...saved[0], sequence: 2, observedAt: 10_020 };
    autosave.events = [departed, currentSaved];
    autosave.relevant_events = [departed, currentSaved];
    autosave.saving_to_saved_transitions = [];
    autosave.changed_saved_nodes = [];
    autosave.departure_to_saved_transitions = [{
      channel_key: 'testid:article-save-status',
      previous_live_sequence: null,
      previous_live_token: baseline[0].token,
      previous_live_node_instance: 1,
      departure_sequence: 1,
      saved_sequence: 2,
      saved_token: currentSavedToken,
      saved_node_instance: 1,
    }];
    autosave.post_mutation_saved_observations = [currentSaved];
    autosave.verified = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.autosaveVerified).toBe(false);
    }
  });

  test('downgrades an unrelated save-status UI change after reload succeeds', async () => {
    const result = strictUploadResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const autosave = persistence.autosave_before_reload as Record<string, unknown>;
    const header = {
      channelKey: 'id:detail-header',
      nodeInstance: 1,
      state: 'saved',
      text: '草稿 · 刚刚最后保存',
      attributes: { state: '', status: '', version: '', busy: '', datetime: '' },
      token: 'unchanged-header-token',
    };
    const unrelated = {
      channelKey: 'role:status|index:1',
      nodeInstance: 2,
      state: 'saved',
      text: 'Saved',
      attributes: { state: '', status: '', version: '2', busy: '', datetime: '' },
      token: 'unrelated-new-token',
      sequence: 23,
      observedAt: 10_010,
    };
    const replayedHeader = { ...header, sequence: 24, observedAt: 10_010 };
    autosave.lastMutationAt = 10_005;
    autosave.lastMutationEventCursor = 22;
    autosave.lastMutationSequence = 22;
    autosave.last_mutation_sequence = 22;
    autosave.mutationBaseline = [
      header,
      { ...unrelated, token: 'unrelated-old-token', sequence: undefined, observedAt: undefined },
    ];
    autosave.current = [header];
    autosave.events = [unrelated, replayedHeader];
    autosave.relevant_events = [unrelated, replayedHeader];
    autosave.saving_to_saved_transitions = [];
    autosave.changed_saved_nodes = [];
    autosave.post_mutation_saved_observations = [replayedHeader];
    autosave.saved_state_present = true;
    autosave.verified = true;
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.autosaveVerified).toBe(false);
    }
  });

  test('downgrades a stale blank-draft baseline when final reload content is exact', async () => {
    const result = strictUploadResult();
    const persistence = result.persistence_evidence as Record<string, unknown>;
    const replacement = persistence.replacement_clear as Record<string, unknown>;
    replacement.cleared = { ...zeroDraftState(), body_media_count: 1, verified: true };
    const state = successfulResultHarness(result);

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.verificationWarnings.join(' ')).toContain('blank-draft baseline');
    }
  });

  test('keeps a draft partial when exact body SHA-256 readback differs', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult({
          exactCompactSha256: false,
          contentCompactSha256: 'b'.repeat(64),
        })),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('内容一致性校验失败');
  });

  test('fails closed when a result lacks reload persistence evidence', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult({
          persistence_verified: false,
        })),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('reload persistence was not verified');
  });

  test('fails closed for an older result without body-media persistence fields', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult({
          body_media_count: undefined,
          expected_body_media: undefined,
        })),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).toContain('body_media_count is invalid');
  });

  test('accepts checkpoint positions measured in Unicode code points', async () => {
    const emojiPreflight = validateXArticlePreflight({
      ...dryRunJson(),
      content_checkpoints: ['😀', 'Body', 'sentence.'],
      expected_compact_length: 14,
    }, prepared().contentHash);
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      const result = strictUploadResult({
        contentCheckpoints: ['😀', 'Body', 'sentence.'],
        matchedCheckpoints: ['😀', 'Body', 'sentence.'],
        checkpointPositions: [0, 1, 5],
        expectedCompactLength: 14,
        compactTextLength: 14,
      });
      const persistence = result.persistence_evidence as Record<string, unknown>;
      persistence.content_before_reload = {
        ...strictPreReloadContent(),
        expectedCompactLength: 14,
        compactTextLength: 14,
      };
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(result),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), {
      preflight: emojiPreflight,
    });

    expect(outcome.status).toBe('success');
  });

  test('returns an explicit partial draft on failure and never retries', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      child.finish(1, `draft_url=${draftUrl}\n`, 'simulated failure');
    });
    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({
      status: 'partial-draft',
      failureKind: 'failed',
      draftUrl,
      result: null,
    });
    expect(outcome.message).toContain('原因：simulated failure');
    expect(state.files.get('/tmp/upload-unique/run.log')?.text).toContain('simulated failure');
    expect(state.calls).toHaveLength(1);
  });

  test('reports cancellation as cancellation instead of presenting the last image progress as an error', async () => {
    const controller = new AbortController();
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      child.stdout.write([
        `draft_url=${draftUrl}`,
        'image 22/24 anchor=合成测试锚点 media=2',
        '',
      ].join('\n'));
    });
    const pending = uploader(state.dependencies).upload(prepared(), {
      preflight: preflight(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    controller.abort();

    const outcome = await pending;
    expect(outcome).toMatchObject({
      status: 'partial-draft',
      failureKind: 'cancelled',
      draftUrl,
    });
    expect(outcome.message).toContain('操作收到取消信号');
    expect(outcome.message).not.toContain('image 22/24');
    expect(outcome.message).not.toContain('anchor=合成测试锚点');
  });

  test('preserves the Python partial failure envelope and phase in run.log', async () => {
    const failureEnvelope = {
      verification_contract: 'x-article-persistence-v1',
      status: 'partial',
      result_ok: false,
      persistence_verified: false,
      autosave_verified: false,
      phase: 'verify_post_reload_tables_media_cover',
      mutation_epoch: mutationEpoch,
      draft_url: draftUrl,
      resume_images_only: false,
      error_type: 'RuntimeError',
      error: 'Post-reload sentinel mismatch',
      screenshot_written: false,
    };
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        text: JSON.stringify(failureEnvelope),
        mtimeMs: 10_100,
      });
      child.finish(
        1,
        `draft_url=${draftUrl}\nRESULT_OK False\n`,
        `UPLOAD_PARTIAL ${JSON.stringify(failureEnvelope)}\nRuntimeError: Post-reload sentinel mismatch`,
      );
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    const log = state.files.get('/tmp/upload-unique/run.log')?.text ?? '';
    expect(log).toContain('verify_post_reload_tables_media_cover');
    expect(log).toContain('Post-reload sentinel mismatch');
    expect(state.calls).toHaveLength(1);
  });

  test('redacts credentials from the private process diagnostic and UI summary', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      child.finish(
        1,
        `draft_url=${draftUrl}\n`,
        [
          'authorization=secret-value auth_token=secret-token',
          '{"name":"auth_token","value":"cookie-object-secret","domain":".x.com"}',
          '{"value":"reverse-cookie-secret","name":"ct0"}',
          '{"name":"auth_token","domain":".x.com","value":"interleaved-cookie-secret"}',
          '{\n  "name": "ct0",\n  "domain": ".x.com",\n  "value": "pretty-cookie-secret"\n}',
          '{"name":"auth_token","domain":".x.com","value":"escaped-cookie-\\"secret"}',
          '{"ct0":"json-field-secret"}',
          'Set-Cookie: auth_token=set-cookie-secret; Path=/; Secure',
        ].join('\n'),
      );
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(outcome.message).not.toContain('secret-value');
    expect(outcome.message).not.toContain('secret-token');
    const log = state.files.get('/tmp/upload-unique/run.log')?.text ?? '';
    expect(log).not.toContain('secret-value');
    expect(log).not.toContain('secret-token');
    expect(log).not.toContain('cookie-object-secret');
    expect(log).not.toContain('reverse-cookie-secret');
    expect(log).not.toContain('interleaved-cookie-secret');
    expect(log).not.toContain('pretty-cookie-secret');
    expect(log).not.toContain('escaped-cookie-');
    expect(log).not.toContain('json-field-secret');
    expect(log).not.toContain('set-cookie-secret');
    expect(log).toContain('authorization=<redacted>');
    expect(log).toContain('auth_token=<redacted>');
  });

  test('keeps the draft partial when stdout and the URL artifact disagree', async () => {
    const otherDraftUrl = 'https://x.com/compose/articles/edit/9876543210';
    const state = harness((child, args) => {
      const resultPath = option(args, '--result-json');
      const urlPath = option(args, '--url-output');
      const screenshotPath = option(args, '--screenshot');
      state.files.set(urlPath, { text: otherDraftUrl, mtimeMs: 10_100 });
      state.files.set(screenshotPath, { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(resultPath, { text: '{}', mtimeMs: 10_100 });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({
      status: 'partial-draft',
      draftUrl,
      result: null,
    });
    expect(outcome.message).toContain('URL 产物彼此不一致');
    expect(state.calls).toHaveLength(1);
  });

  test('does not report success without a fresh valid URL artifact', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--result-json'), { text: '{}', mtimeMs: 10_100 });
      state.files.set(option(args, '--url-output'), { text: 'not-an-x-draft-url', mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
    expect(state.calls).toHaveLength(1);
  });

  test('does not accept extra native tables as a strict success', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--url-output'), { text: draftUrl, mtimeMs: 10_100 });
      state.files.set(option(args, '--screenshot'), { text: 'PNG', mtimeMs: 10_100 });
      state.files.set(option(args, '--result-json'), {
        mtimeMs: 10_100,
        text: JSON.stringify(strictUploadResult({
          tableCount: 1,
          nativeTableNodesFound: 1,
        })),
      });
      child.finish(0, `draft_url=${draftUrl}\nRESULT_OK True\n`);
    });

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome).toMatchObject({ status: 'partial-draft', draftUrl, result: null });
  });

  test('never starts the browser when the bound preflight contains blockers', async () => {
    const state = harness(child => child.finish(0, 'should not run'));
    const blocked = {
      ...preflight(),
      errors: [{ type: 'blocked', message: 'stop', details: {} }],
    };

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: blocked });

    expect(outcome.status).toBe('failed');
    expect(outcome.draftUrl).toBeNull();
    expect(state.calls).toHaveLength(0);
  });

  test('a persistent cancel latch prevents any later browser process from starting', async () => {
    const state = harness(child => child.finish(0, 'should not run'));
    const instance = uploader(state.dependencies);
    instance.cancel();

    await expect(instance.upload(prepared(), { preflight: preflight() }))
      .rejects.toThrow('cancelled');
    expect(state.calls).toHaveLength(0);
  });

  test('rejects a prepared Markdown file changed after preflight', async () => {
    const state = harness(child => child.finish(0, 'should not run'));
    const fixture = state.files.get('/tmp/prepared.md');
    if (!fixture) throw new Error('missing prepared fixture');
    fixture.text = '# Tampered after preflight\n';

    await expect(uploader(state.dependencies).upload(prepared(), { preflight: preflight() }))
      .rejects.toThrow('changed after preflight');
    expect(state.calls).toHaveLength(0);
  });

  test('rejects a staged image whose bytes changed without changing its size', async () => {
    const state = harness(child => child.finish(0, 'should not run'));
    const fixture = prepared();
    fixture.resolvedImages = [{
      sourcePath: '/vault/article.md',
      target: 'image.png',
      alt: 'image',
      kind: 'markdown',
      remote: false,
      absolutePath: '/tmp/staged-image.png',
      cover: false,
    }];
    fixture.assetDigests = [{
      path: '/tmp/staged-image.png',
      sha256: createHash('sha256').update('PNG', 'utf8').digest('hex'),
      size: 3,
    }];
    state.files.set('/tmp/staged-image.png', { text: 'BAD', mtimeMs: 9_000 });
    const boundPreflight = validateXArticlePreflight(dryRunJson(1), fixture.contentHash);

    await expect(uploader(state.dependencies).upload(fixture, { preflight: boundPreflight }))
      .rejects.toThrow('hash changed');
    expect(state.calls).toHaveLength(0);
  });

  test('exclusively pre-creates a missing Cookie output and locks it to mode 0600 before export', async () => {
    const stagingPath = '/tmp/.cookies.json.chrome-export.json';
    let privateAtSpawn = false;
    const state = harness((child, args) => {
      privateAtSpawn = state.privateCreates.includes(stagingPath)
        && state.chmods.some(([filePath, mode]) => filePath === stagingPath && mode === 0o600);
      state.files.set(option(args, '--output'), {
        text: JSON.stringify([
          { name: 'auth_token', value: 'secret-one', domain: '.x.com' },
          { name: 'ct0', value: 'secret-two', domain: 'x.com' },
        ]),
        mtimeMs: 10_100,
      });
      child.finish(0, 'exported=2\n');
    });
    state.files.delete('/tmp/cookies.json');

    const status = await uploader(state.dependencies).exportCookies();

    expect(status).toMatchObject({ cookieCount: 2, requiredNamesPresent: true });
    expect(privateAtSpawn).toBe(true);
    expect(state.privateCreates).toEqual([stagingPath]);
    expect(state.privateWrites.some(([filePath]) => filePath === '/tmp/cookies.json')).toBe(true);
    expect(state.chmods).toContainEqual(['/tmp/cookies.json', 0o600]);
  });

  test('refuses Cookie export before spawning or writing when the Home writer fence is unavailable', async () => {
    const state = harness(child => child.finish(0, 'must-not-run'));
    const guarded = new XArticleLocalUploader({
      pythonCommand: 'python3',
      cookiesPath: '/tmp/cookies.json',
      runtime,
      dependencies: state.dependencies,
      authorizeCookieMutation: async () => {
        throw new Error('Home writer process lock is not held');
      },
    });

    await expect(guarded.exportCookies()).rejects.toThrow('Home writer process lock');
    expect(state.calls).toHaveLength(0);
    expect(state.privateCreates).toHaveLength(0);
    expect(state.privateWrites).toHaveLength(0);
    expect(state.chmods).toHaveLength(0);
  });

  test('filters evil and malformed domains from the persisted Cookie export', async () => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--output'), {
        text: JSON.stringify([
          { name: 'auth_token', value: 'secret-one', domain: '.x.com', path: '/' },
          { name: 'tracking', value: 'must-disappear', domain: 'notx.com' },
          { name: 'also_tracking', value: 'must-disappear-too', domain: 'x.com.evil.example' },
          { name: 'empty', value: '', domain: 'x.com' },
          { name: 'ct0', value: 'secret-two', domain: 'X.COM', secure: true },
        ]),
        mtimeMs: 10_100,
      });
      child.finish(0, 'exported=5\n');
    });

    const status = await uploader(state.dependencies).exportCookies();
    const persisted = JSON.parse(state.files.get('/tmp/cookies.json')?.text ?? 'null') as Array<Record<string, unknown>>;

    expect(status.cookieCount).toBe(2);
    expect(persisted.map(cookie => cookie.name)).toEqual(['auth_token', 'ct0']);
    expect(persisted.map(cookie => cookie.domain)).toEqual(['.x.com', 'x.com']);
    expect(JSON.stringify(persisted)).not.toContain('must-disappear');
    expect(state.privateWrites.filter(([filePath]) => filePath === '/tmp/cookies.json')).toHaveLength(1);
  });

  test('leaves the previous canonical Cookie bytes unchanged when the child fails or exports invalid data', async () => {
    const previous = JSON.stringify([
      { name: 'auth_token', value: 'old-one', domain: '.x.com' },
      { name: 'ct0', value: 'old-two', domain: 'x.com' },
    ]);
    const failed = harness((child, args) => {
      failed.files.set(option(args, '--output'), { text: '[{"partial":', mtimeMs: 10_100 });
      child.finish(1, '', 'export failed');
    });
    failed.files.get('/tmp/cookies.json')!.text = previous;

    await expect(uploader(failed.dependencies).exportCookies()).rejects.toThrow('导出失败');
    expect(failed.files.get('/tmp/cookies.json')?.text).toBe(previous);
    expect(failed.privateWrites.some(([filePath]) => filePath === '/tmp/cookies.json')).toBe(false);

    const invalid = harness((child, args) => {
      invalid.files.set(option(args, '--output'), {
        text: JSON.stringify([
          { name: 'auth_token', value: 'new-one', domain: 'x.com.evil.example' },
          { name: 'ct0', value: 'new-two', domain: 'x.com' },
        ]),
        mtimeMs: 10_100,
      });
      child.finish(0, 'exported=2\n');
    });
    invalid.files.get('/tmp/cookies.json')!.text = previous;

    await expect(uploader(invalid.dependencies).exportCookies()).rejects.toThrow('auth_token');
    expect(invalid.files.get('/tmp/cookies.json')?.text).toBe(previous);
    expect(invalid.privateWrites.some(([filePath]) => filePath === '/tmp/cookies.json')).toBe(false);
  });

  test('rechecks the Home writer fence after Chrome export and before canonical commit', async () => {
    const previous = JSON.stringify([
      { name: 'auth_token', value: 'old-one', domain: '.x.com' },
      { name: 'ct0', value: 'old-two', domain: 'x.com' },
    ]);
    const state = harness((child, args) => {
      state.files.set(option(args, '--output'), {
        text: JSON.stringify([
          { name: 'auth_token', value: 'new-one', domain: '.x.com' },
          { name: 'ct0', value: 'new-two', domain: 'x.com' },
        ]),
        mtimeMs: 10_100,
      });
      child.finish(0, 'exported=2\n');
    });
    state.files.get('/tmp/cookies.json')!.text = previous;
    let authorizationChecks = 0;
    const guarded = new XArticleLocalUploader({
      pythonCommand: 'python3',
      cookiesPath: '/tmp/cookies.json',
      runtime,
      dependencies: state.dependencies,
      authorizeCookieMutation: async () => {
        authorizationChecks += 1;
        if (authorizationChecks > 1) throw new Error('Home writer process lock was released');
      },
      commitCanonicalCookies: text => commitTestCookies(state.dependencies, text),
    });

    await expect(guarded.exportCookies()).rejects.toThrow('lock was released');
    expect(authorizationChecks).toBe(2);
    expect(state.files.get('/tmp/cookies.json')?.text).toBe(previous);
    expect(state.privateWrites.some(([filePath]) => filePath === '/tmp/cookies.json')).toBe(false);
  });

  test.each([
    {
      name: 'expired required Cookies',
      previous: JSON.stringify([
        { name: 'auth_token', value: 'expired-one', domain: '.x.com', expires: 1 },
        { name: 'ct0', value: 'expired-two', domain: 'x.com', expires: 1 },
      ]),
    },
    {
      name: 'a supported wrapper missing ct0',
      previous: JSON.stringify({
        cookies: [
          { name: 'auth_token', value: 'old-one', domain: '.x.com' },
          { name: 'lang', value: 'zh', domain: 'x.com' },
        ],
      }),
    },
  ])('Chrome export atomically replaces $name', async ({ previous }) => {
    const state = harness((child, args) => {
      state.files.set(option(args, '--output'), {
        text: JSON.stringify([
          { name: 'auth_token', value: 'new-one', domain: '.x.com' },
          { name: 'ct0', value: 'new-two', domain: 'x.com' },
        ]),
        mtimeMs: 10_100,
      });
      child.finish(0, 'exported=2\n');
    });
    state.files.get('/tmp/cookies.json')!.text = previous;

    const status = await uploader(state.dependencies).exportCookies();

    expect(status).toMatchObject({ cookieCount: 2, requiredNamesPresent: true });
    expect(state.calls).toHaveLength(1);
    expect(state.privateWrites.filter(([filePath]) => filePath === '/tmp/cookies.json')).toHaveLength(1);
    const persisted = JSON.parse(state.files.get('/tmp/cookies.json')?.text ?? 'null') as Array<Record<string, unknown>>;
    expect(persisted.map(cookie => cookie.name)).toEqual(['auth_token', 'ct0']);
    expect(JSON.stringify(persisted)).not.toContain('old-one');
    expect(JSON.stringify(persisted)).not.toContain('expired-one');
  });

  test('auto-export refreshes an expired canonical Cookie file before upload', async () => {
    const state = harness((child, args, call) => {
      if (call === 1) {
        expect(args).toContain(runtime.cookieExportScript);
        state.files.set(option(args, '--output'), {
          text: JSON.stringify([
            { name: 'auth_token', value: 'new-one', domain: '.x.com' },
            { name: 'ct0', value: 'new-two', domain: 'x.com' },
          ]),
          mtimeMs: 10_100,
        });
        child.finish(0, 'exported=2\n');
        return;
      }
      child.finish(1, '', 'simulated upload stop');
    });
    state.files.get('/tmp/cookies.json')!.text = JSON.stringify([
      { name: 'auth_token', value: 'expired-one', domain: '.x.com', expires: 1 },
      { name: 'ct0', value: 'expired-two', domain: 'x.com', expires: 1 },
    ]);

    const outcome = await autoExportUploader(state.dependencies)
      .upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('failed');
    expect(state.calls).toHaveLength(2);
    expect(state.calls[0].args).toContain(runtime.cookieExportScript);
    expect(state.privateWrites.filter(([filePath]) => filePath === '/tmp/cookies.json')).toHaveLength(1);
  });

  test('refuses to replace an unrelated array stored at the canonical Cookie path', async () => {
    const state = harness(child => child.finish(0, 'must not run'));
    const unrelated = JSON.stringify([
      { project: 'keep-me', nested: { purpose: 'not-cookies' } },
    ]);
    state.files.get('/tmp/cookies.json')!.text = unrelated;

    await expect(uploader(state.dependencies).exportCookies()).rejects.toThrow('拒绝覆盖');
    expect(state.files.get('/tmp/cookies.json')?.text).toBe(unrelated);
    expect(state.calls).toHaveLength(0);
    expect(state.privateWrites).toHaveLength(0);
  });

  test('auto-export refreshes an empty Cookie file but never overwrites arbitrary JSON', async () => {
    const refresh = harness((child, args, call) => {
      if (call === 1) {
        expect(args).toContain(runtime.cookieExportScript);
        refresh.files.set(option(args, '--output'), {
          text: JSON.stringify([
            { name: 'auth_token', value: 'secret-one', domain: '.x.com' },
            { name: 'ct0', value: 'secret-two', domain: 'x.com' },
          ]),
          mtimeMs: 10_100,
        });
        child.finish(0, 'exported=2\n');
        return;
      }
      child.finish(1, '', 'simulated upload stop');
    });
    const emptyCookie = refresh.files.get('/tmp/cookies.json');
    if (!emptyCookie) throw new Error('missing fixture');
    emptyCookie.text = '';

    const refreshed = await autoExportUploader(refresh.dependencies)
      .upload(prepared(), { preflight: preflight() });

    expect(refreshed.status).toBe('failed');
    expect(refresh.calls).toHaveLength(2);
    expect(refresh.calls[0].args).toContain(runtime.cookieExportScript);

    const arbitrary = harness(child => child.finish(0, 'must not run'));
    const arbitraryText = JSON.stringify({ project: 'keep-me', nested: { cookies: 'not-a-list' } });
    const arbitraryCookie = arbitrary.files.get('/tmp/cookies.json');
    if (!arbitraryCookie) throw new Error('missing fixture');
    arbitraryCookie.text = arbitraryText;

    const rejected = await autoExportUploader(arbitrary.dependencies)
      .upload(prepared(), { preflight: preflight() });

    expect(rejected.status).toBe('failed');
    expect(rejected.message).toContain('拒绝覆盖');
    expect(arbitrary.files.get('/tmp/cookies.json')?.text).toBe(arbitraryText);
    expect(arbitrary.privateWrites).toHaveLength(0);
    expect(arbitrary.calls).toHaveLength(0);
  });

  test('validates cookie domains without exporting or exposing values', async () => {
    const state = harness(child => child.finish(0, ''));
    const cookie = state.files.get('/tmp/cookies.json');
    if (!cookie) throw new Error('missing fixture');
    cookie.text = JSON.stringify([
      { name: 'auth_token', value: 'do-not-print', domain: '.x.com' },
      { name: 'ct0', value: 'do-not-print-either', domain: 'evil.example' },
    ]);
    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });

    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('非白名单域名');
    expect(outcome.message).not.toContain('do-not-print');
    expect(state.calls).toHaveLength(0);
  });

  test('refuses to read a group-readable canonical Cookie file before spawning X', async () => {
    const state = harness(child => child.finish(0, 'must-not-run'));
    const originalStat = state.dependencies.stat!;
    state.dependencies.stat = async filePath => {
      const stat = await originalStat(filePath);
      return filePath === '/tmp/cookies.json' ? { ...stat, mode: 0o640 } : stat;
    };

    const outcome = await uploader(state.dependencies).upload(prepared(), { preflight: preflight() });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('权限不安全');
    expect(state.calls).toHaveLength(0);
  });
});
