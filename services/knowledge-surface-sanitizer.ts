/**
 * Generic knowledge surfaces must not expose or rank internal calibration
 * metadata. Keep the source object untouched because the calibration workflow
 * still needs the original fields.
 */
export function sanitizeKnowledgeSurfaceFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(frontmatter).filter(
      ([key]) => !key.toLowerCase().startsWith('calibration_'),
    ),
  )
}
