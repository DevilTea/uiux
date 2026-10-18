import { createWidgetValueContract } from '@deviltea/widget-core'

import { STRING_VALUE_CONTRACT_ID, TRANSLATION_RESULT_VALUE_CONTRACT_ID } from '../adapter-entry'
import type { TranslationResult } from '../domain/i18n/schema'

// The value-contract IDs are defined once, by the public Adapter authoring entry.
export const UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID = TRANSLATION_RESULT_VALUE_CONTRACT_ID
export const UIUX_STRING_VALUE_CONTRACT_ID = STRING_VALUE_CONTRACT_ID

/** Typed authoring token for Adapter Widget Properties that expose structured translation results. */
export const UIUX_TRANSLATION_RESULT_VALUE_CONTRACT
	= createWidgetValueContract<TranslationResult>(UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID)

/** Typed authoring token for Adapter Widget Properties that expose renderer-facing translated text. */
export const UIUX_STRING_VALUE_CONTRACT
	= createWidgetValueContract<string>(UIUX_STRING_VALUE_CONTRACT_ID)
