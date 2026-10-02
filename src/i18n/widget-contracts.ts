import { createWidgetValueContract } from '@deviltea/widget-core'

import type { TranslationResult } from '../domain/i18n/schema'

export const UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID = 'deviltea.uiux/translation-result@1' as const
export const UIUX_STRING_VALUE_CONTRACT_ID = 'deviltea.uiux/string@1' as const

/** Typed authoring token for Adapter Widget Properties that expose structured translation results. */
export const UIUX_TRANSLATION_RESULT_VALUE_CONTRACT
	= createWidgetValueContract<TranslationResult>(UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID)

/** Typed authoring token for Adapter Widget Properties that expose renderer-facing translated text. */
export const UIUX_STRING_VALUE_CONTRACT
	= createWidgetValueContract<string>(UIUX_STRING_VALUE_CONTRACT_ID)
