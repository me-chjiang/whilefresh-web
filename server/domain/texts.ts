export function freshnessFresh(): string {
  return "新鲜";
}

export function freshnessNearExpiry(): string {
  return "临期";
}

export function freshnessBeyond(): string {
  return "超出估计期限";
}

export function freshnessUnknown(): string {
  return "期限未知";
}

export function freshnessBeyondHint(): string {
  return "超出估计期限，请查看后决定";
}

export function freshnessUnknownHint(): string {
  return "还不知道能放多久，可以手动填写";
}

export function sourcePackage(): string {
  return "包装标注";
}

export function sourceManual(): string {
  return "你填写的";
}

export function sourceLocalRule(): string {
  return "你的设置";
}

export function sourceReference(): string {
  return "参考表";
}

export function sourceAiEstimate(): string {
  return "AI 估计";
}

export function sourceNone(): string {
  return "暂无依据";
}

export function estimateTag(): string {
  return "估计";
}

export function referenceAttribution(): string {
  return "参考：USDA FoodKeeper";
}

export function statusInStock(): string {
  return "在库";
}

export function statusUsed(): string {
  return "已用掉";
}

export function statusAbsent(): string {
  return "家里没有";
}

export function orSeparator(): string {
  return " 或 ";
}

export function shoppingListTitle(): string {
  return "待买清单";
}

export function importMayBeIncomplete(): string {
  return "可能有遗漏，请检查";
}

export function importNeedsBaseDate(): string {
  return "图片上有“今天生产”这类日期，但读不到图片的拍摄日期，请确认是哪天拍的";
}

export function importDuplicateImage(): string {
  return "这张图片之前已经导入过";
}

export function importPossibleDuplicate(): string {
  return "这次的商品和最近一次导入很像，可能是重复导入";
}

export function importIgnoredGroup(): string {
  return "已忽略";
}

export function importBusy(): string {
  return "正在识别上一次导入，请稍候";
}

export function importNothingToConfirm(): string {
  return "没有选中任何商品";
}

export function importEmptyInput(): string {
  return "没有可识别的图片或文字";
}

export function uploadPrivacyNotice(): string {
  return "将把所选图片或文字发送到 DeepSeek 识别商品。截图里可能有收货地址、电话、姓名等个人信息，建议先裁掉这些部分再上传。识别结果只保存在本机。";
}

export function uploadPrivacyAgree(): string {
  return "同意并识别";
}

export function demoLabel(): string {
  return "演示";
}

export function suggestionMarkPantryHave(name: string): string {
  return `这次买到了「${name}」，标记为家里有吗？`;
}

export function suggestionAddToPantry(name: string): string {
  return `把「${name}」加入常备，以后默认算家里有吗？`;
}

export function suggestionAddToShopping(name: string): string {
  return `「${name}」家里没有了，加入待买吗？`;
}

export function ruleQuestionShelfLife(
  name: string,
  storage: string,
  days: number,
): string {
  return `以后「${name}」${storage}都按 ${days} 天算吗？`;
}

export function ruleQuestionStorage(name: string, storage: string): string {
  return `以后「${name}」都建议${storage}存放吗？`;
}
