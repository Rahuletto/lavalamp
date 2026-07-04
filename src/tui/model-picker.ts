import type { ModelRegistryEntry } from '../config/models';
import { listModels } from '../config/models';

export interface ModelPickerState {
  models: ModelRegistryEntry[];
  selectedIndex: number;
}

export function createModelPickerState(
  currentModel: string,
  models = listModels(),
): ModelPickerState {
  const selectedIndex = Math.max(
    0,
    models.findIndex((model) => model.id === currentModel),
  );
  return { models, selectedIndex };
}

export function moveModelPickerSelection(
  state: ModelPickerState,
  delta: number,
): void {
  state.selectedIndex = Math.max(
    0,
    Math.min(state.models.length - 1, state.selectedIndex + delta),
  );
}

export function selectedModelId(state: ModelPickerState): string | undefined {
  return state.models[state.selectedIndex]?.id;
}
