export function joinPromptSections(
  sections: readonly (string | null | undefined)[],
  separator = '\n\n'
): string {
  return sections
    .filter(
      (section): section is string =>
        typeof section === 'string' && section.trim().length > 0
    )
    .map((section) => section.trim())
    .join(separator)
}
