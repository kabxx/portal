import { chatgptDefinition } from './chatgpt.ts'
import { deepseekDefinition } from './deepseek.ts'
import { doubaoDefinition } from './doubao.ts'
import { geminiDefinition } from './gemini.ts'
import { glmDefinition } from './glm.ts'
import { grokDefinition } from './grok.ts'
import { kimiDefinition } from './kimi.ts'
import { qwenDefinition } from './qwen.ts'
import {
  defineProviderPack,
  type ProviderDefinitionPack,
} from './provider-definition.ts'

export const PROVIDER_DEFINITIONS = defineProviderPack({
  chatgpt: chatgptDefinition,
  gemini: geminiDefinition,
  deepseek: deepseekDefinition,
  doubao: doubaoDefinition,
  grok: grokDefinition,
  glm: glmDefinition,
  qwen: qwenDefinition,
  kimi: kimiDefinition,
} satisfies ProviderDefinitionPack)

export {
  defineProvider,
  defineProviderPack,
  ProviderDefinitionError,
} from './provider-definition.ts'
export type {
  ProviderCapabilityDefinition,
  ProviderCapabilityDefinitionFor,
  ProviderDefinition,
  ProviderDefinitionInput,
  ProviderDefinitionPack,
  ProviderModelDefinition,
  ProviderModelOptionDefinition,
} from './provider-definition.ts'
