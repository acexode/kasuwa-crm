import type { Translator } from '@kasuwa/i18n/bundle';
import type { Pipeline, PipelineError } from '../../lib/pipelines-api';
import {
  errorMessage,
  fieldLabel,
  findRequirement,
  notEditableFields,
  unmetRequirementIds,
} from './pipeline-model';

/**
 * A refused move as the person reads it (T-0109 R10, T-0110 R14): translated,
 * naming fields and requirements by their labels and never by id. One copy,
 * used by the board and by the deal detail, so a move refused from either
 * says the same thing.
 *
 * A `422 requirements_unmet` naming a requirement the screen never read means
 * the pipeline was reconfigured since: `refreshPipeline` re-reads it to learn
 * the new label. A `409 transition_not_allowed` re-reads it too (without
 * waiting), so the next try is judged against the allow-list as it now is.
 */
export async function moveRefusalText(
  t: Translator,
  error: PipelineError,
  config: Pipeline | null,
  refreshPipeline: () => Promise<Pipeline | null>,
): Promise<string> {
  if (error.code === 'requirements_unmet') {
    let known = config;
    const ids = unmetRequirementIds(error);
    if (ids.some((id) => findRequirement(known, id) === undefined)) {
      known = (await refreshPipeline()) ?? known;
    }
    const labels = ids
      .map((id) => findRequirement(known, id))
      .flatMap((requirement) =>
        requirement === undefined
          ? []
          : [requirement.kind === 'check' ? requirement.label : t.t(fieldLabel(requirement.field))],
      );
    return labels.length === 0
      ? t.t('records.error.requirements_unmet')
      : t.t('pipeline.move.unmet', { requirements: labels.join(', ') });
  }
  const fields = notEditableFields(error);
  if (fields.length > 0) {
    return t.t('pipeline.move.field_not_editable', {
      fields: fields.map((field) => t.t(fieldLabel(field))).join(', '),
    });
  }
  if (error.code === 'transition_not_allowed') {
    void refreshPipeline();
  }
  return t.t(errorMessage(error));
}
