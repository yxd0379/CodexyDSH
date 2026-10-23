/**
 * Fixed first-use Workspace naming, shared by the Host that creates the
 * directory and by browser consumers that label the resulting row. A pure fold
 * with no imports, so client bundles inline it instead of requesting a
 * module-table row this package does not publish.
 * @module @deepseek-ai/dsh-api-workspace-controller/default-workspace
 */

/**
 * 首次创建的默认工作区位于 `<Documents>/CodexyDSH/default-workspace`。
 * 此目录名仅用于首次创建；已有工作区仍由注册表原样返回，不迁移或重命名。
 * 注册表以相同的末级目录名作为初始标题，由
 * {@link workspaceDisplayTitle} 识别为默认名称。
 */
export const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'

/**
 * The text one Workspace is labeled with. A Workspace still carrying the
 * automatic first-use title reads as the caller's localized default name; every
 * other title reads verbatim in every language. A title the user typed as
 * exactly {@link DEFAULT_WORKSPACE_DIRECTORY} is labeled as the default too;
 * nothing else depends on the distinction.
 * @param title - stored Workspace title.
 * @param localizedDefault - the default Workspace name in the active language.
 * @returns the title to display.
 */
export function workspaceDisplayTitle(title: string, localizedDefault: string): string {
  return title === DEFAULT_WORKSPACE_DIRECTORY ? localizedDefault : title
}
