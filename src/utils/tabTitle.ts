import type { WorkspaceTab } from '../contracts/workspace';
import type { TranslationKey, TranslationParams } from '../i18n/translate';

/**
 * 标签标题：有文案键就按当前语言翻译，没有就用存下来的字符串。
 *
 * 表名和视图名是数据库里的真实标识符，不该翻译，所以没有键；
 * 「新建查询」这类我们自己生成的标题才有。工作区快照里存的是键和参数，
 * 于是切换语言后**已经打开的标签也会跟着变**——否则界面会一半中文一半英文。
 */
export function tabTitle(
  tab: Pick<WorkspaceTab, 'title' | 'titleKey' | 'titleParams'>,
  t: (key: TranslationKey, params?: TranslationParams) => string
): string {
  if (!tab.titleKey) {
    return tab.title;
  }
  return t(tab.titleKey as TranslationKey, tab.titleParams);
}
