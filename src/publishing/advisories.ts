export interface WeChatPublishingAdvisory {
  code: string;
  title: string;
  message: string;
}

export function getWeChatPublishingAdvisories(
  _bodyImageCount: number,
): WeChatPublishingAdvisory[] {
  // WeChat news articles do not share X Article's 25-body-media cap.
  // Keep count-based policy explicit here so it cannot be accidentally
  // reintroduced when the two publishing targets share UI components.
  return [];
}
