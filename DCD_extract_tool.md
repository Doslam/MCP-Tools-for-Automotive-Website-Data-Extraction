### 1. extract_dcd_by_url

等待抖音页面加载完成，检查视频容器和视频元素是否出现。

**工具名称**: `extract_dcd_by_url`

**参数**:
- `url` (string, 可选): 懂车帝帖子页面url
- `urls` (list[string]，可选): 多个懂车帝帖子url，以list形式传入
注：需至少包含一个url

**返回**:
```json
[{
  "url": "",
  "videosFound": 0,
  "ready": true,
  "timeout": false
}]
```

**使用示例**:
```python
result = await session.call_tool(
    "wait_for_douyin_page_load",
    {"timeout": 15000}
)
```

**定义**: `waitForDouyinPageLoad` in `script.ts:91`

---