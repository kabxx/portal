export function formatProviderDisplayName(providerId: string): string {
  return providerId === 'chatgpt'
    ? 'ChatGPT'
    : providerId === 'deepseek'
      ? 'DeepSeek'
      : providerId === 'glm'
        ? 'GLM'
        : providerId.charAt(0).toUpperCase() + providerId.slice(1)
}
