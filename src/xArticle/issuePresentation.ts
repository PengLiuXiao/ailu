import {
  X_ARTICLE_MAX_BODY_MEDIA,
  type XArticlePreflight,
  type XArticlePreflightIssue,
} from './types';
import { userFacingErrorText } from '../utils/userFacingError';

export interface XArticleIssuePresentation {
  title: string;
  message: string;
}

type XArticlePreflightSummary = Pick<XArticlePreflight, 'expectedBodyImages'>;

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function issueIndex(issue: XArticlePreflightIssue): number | null {
  return positiveInteger(issue.details.index);
}

export function presentXArticlePreflightIssue(
  preflight: XArticlePreflightSummary,
  issue: XArticlePreflightIssue,
): XArticleIssuePresentation {
  if (issue.type === 'body_media_limit_exceeded') {
    const maximum = positiveInteger(issue.details.maximum) ?? X_ARTICLE_MAX_BODY_MEDIA;
    const bodyImages = preflight.expectedBodyImages;
    const excess = Math.max(0, bodyImages - maximum);
    return {
      title: `正文图片太多：${bodyImages} 张，需要减少 ${excess} 张`,
      message: `图片文件本身没有损坏。X 正文最多接收 ${maximum} 张图片；封面单独上传，不占正文名额。可以删除次要截图、合并连续截图，或把文章拆成两篇。`,
    };
  }

  const index = issueIndex(issue);
  const presentations: Record<string, XArticleIssuePresentation> = {
    missing_cover_file: {
      title: '封面图片文件找不到',
      message: '请检查封面图片路径，或移除失效的封面引用。',
    },
    missing_body_image: {
      title: index ? `第 ${index} 张正文图片文件找不到` : '有正文图片文件找不到',
      message: '请检查这张图片的本地路径，确认文件仍在当前 Vault 内。',
    },
    weak_image_anchor: {
      title: index ? `第 ${index} 张图片前缺少明确说明` : '有图片前缺少明确说明',
      message: '请在图片前补一行唯一、明确的说明文字，以便准确放回原位置。',
    },
    reused_anchor: {
      title: '多张图片使用了相同的定位文字',
      message: '请把这些图片前的说明文字改得彼此不同。',
    },
    unsupported_remote_image: {
      title: '文章里有尚未下载的网络图片',
      message: '请先把网络图片保存到当前 Vault，再改用本地图片路径。',
    },
    unsupported_reference_image: {
      title: '有图片使用了暂不支持的引用写法',
      message: '请把图片改成 ![说明](本地路径) 这种写法。',
    },
    unsupported_raw_html: {
      title: '正文包含暂不支持的 HTML',
      message: '请把代码围栏外的 HTML 改成 Markdown。',
    },
    unsupported_divider: {
      title: '正文包含暂不支持的分隔线',
      message: '请删除 Markdown 分隔线，或改用普通文字分隔。',
    },
    table_too_large: {
      title: index ? `第 ${index} 个表格超过 10 × 10` : '有表格超过 10 × 10',
      message: '请拆分表格、减少行列，或把大表格转成图片。',
    },
  };

  return presentations[issue.type] ?? {
    title: '检查发现一个需要处理的问题',
    message: userFacingErrorText(
      issue.message,
      '请根据检查结果修正文章后重新检查。',
    ),
  };
}
