# 基于 MCP 的汽车网站信息抽取工具

本项目实现了一个**基于 MCP（Model Context Protocol）的浏览器自动化数据抽取系统**，  
用于从主流中文汽车社区平台（**懂车帝车友圈** 与 **汽车之家论坛**）中**稳定获取结构化帖子与评论数据**。

系统重点解决真实网页环境中的常见难题，包括：

- 评论区**懒加载**与**虚拟列表渲染**
- 用户交互后产生的**动态 DOM 更新**
- **多层嵌套回复**与折叠内容展开
- **占位图、表情图过滤**与图片数据清洗
- URL **规范化处理**与**去重策略**

---

## ✨ 核心功能

- **基于 MCP 的浏览器内自动化执行能力**  
  实现在真实页面上下文中的点击、滚动、展开与数据读取。

- **稳健的 DOM 结构化抽取逻辑**  
  支持获取帖子正文、评论、回复、图片及元信息。

- **自动展开隐藏评论与嵌套回复**  
  结合交互模拟与状态检测，避免数据遗漏。

- **图片清洗与过滤流程**  
  自动剔除占位图、UI 资源与表情图片，仅保留真实用户内容图。

- **URL 规范化与去重**  
  统一处理 query/hash，保证数据存储一致性。

  
  ## 📦 抽取数据结构示例

```json
{
  "post": {
    "title": "...",
    "author": "...",
    "time": "...",
    "content": "...",
    "images": []
  },
  "comments": [
    {
      "author": "...",
      "content": "...",
      "time": "...",
      "images": [],
      "replies": []
    }
  ]
}
## 🚀 快速开始

### 0. 环境准备

请先确保本地已安装以下运行环境：

#### Node.js（包含 npm）

```bash
node -v
npm -v

如未安装，请前往：https://nodejs.org 下载并安装最新 LTS 版本。

####Python（用于部分数据处理或脚本）
```bash
python --version

本项目使用 pyproject.toml 管理 Python 依赖。
### 1. 克隆仓库
git clone https://github.com/your-username/MCP-Tools-for-Automotive-Website-Data-Extraction.git
cd MCP-Tools-for-Automotive-Website-Data-Extraction

### 2. 安装依赖
```bash
npm install

### 3. 构建项目
```bash
npm run build

### 4. 运行脚本
```



