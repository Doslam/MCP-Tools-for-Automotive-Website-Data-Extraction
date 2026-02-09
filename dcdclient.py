import asyncio
from pathlib import Path
import re
from typing import Optional
from contextlib import AsyncExitStack
import json

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

#from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()  # 从 .env 加载环境变量

class MCPClient:
    def __init__(self):
        # 初始化会话和客户端对象
        self.session: Optional[ClientSession] = None
        self.exit_stack = AsyncExitStack()
        #self.anthropic = Anthropic()
    # 方法将在这里添加

    async def navigate_page(self,url: str = None):
        try:
            print("url参数:",url)
            target_url = url if url else 'https://www.bilibili.com/video/BV1E5zQBGErs/?vd_source=7b9107983f3f829d4a2ac94954ee3673'
            nav_result = await self.session.call_tool(
                "navigate_page",
                {"type":"url",
                "url":target_url})
            print(f"✓ 已打开链接\n",f"连接接地址为: {target_url}\n")
            await asyncio.sleep(5)  # 等待页面加载 完成
            #print("导航结果:", nav_result)
        #called_tools.append({"name":"navigate_page","params":{"type":"url","url":target_url}})
        except Exception as e:
            print(e,"\n请检查输入的链接是否正确")

    async def connect_to_server(self, server_script_path: str="./chrome-devtools-mcp/build/src/index.js"):
        """连接到 MCP 服务器

        参数：
            server_script_path: 服务器脚本的路径（.py 或 .js）
        """
        is_python = server_script_path.endswith('.py')
        is_js = server_script_path.endswith('.js')
        if not (is_python or is_js):
            raise ValueError("服务器脚本必须是 .py 或 .js 文件")

        command = "python" if is_python else "node"
        server_params = StdioServerParameters(
            command=command,
            args=[server_script_path],
            env=None
        )

        stdio_transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
        self.stdio, self.write = stdio_transport
        self.session = await self.exit_stack.enter_async_context(ClientSession(self.stdio, self.write))

        await self.session.initialize()

    async def tools_description(self):
        """获取工具描述"""
        if not self.session:
            raise RuntimeError("未连接到服务器")

        # 获取工具描述
        response = await self.session.list_tools()
        tools = response.tools
        for tool in tools:
            print(f"\n工具: {tool.name}")
            print(f"描述: {tool.description}")
            #print(f"参数: {tool.parameters}")


    
    async def snapshot_page(self):
        try: 
            snap_path = str(Path(__file__).parent / "shot.json")
            page_info = await self.session.call_tool(
                "take_snapshot",
                {"filePath": snap_path}            
                )
            print(f"✓ 已保存页面快照到: {Path(__file__).parent / 'shot.json'}\n")
        except Exception as e:
            print(e,"\n截图失败")

   
    
    async def get_dcdcomment(self,url: str | list[str] = None):
        """获取懂车帝页面评论"""
        try:
            print(type(url))
            if type(url) == str: 
                res = await self.session.call_tool(
                    "extract_dcd_by_url",
                    {"url": url}
                    )
            elif type(url) == list: 
                res = await self.session.call_tool(
                    "extract_dcd_by_url",
                    {"urls": url}
                    )
            print("✓ 获取评论成功:", res.content[0].text,"\n")
        except Exception as e:
            print(e,"\n获取评论失败")
    async def get_qczjcomment(self,url: str | list[str] = None):
        """获取汽车之家论坛页面评论"""
        try:
            print(type(url))
            if type(url) == str: 
                res = await self.session.call_tool(
                    "extract_qczj_by_url",
                    {"url": url}
                    )
            elif type(url) == list: 
                res = await self.session.call_tool(
                    "extract_qczj_by_url",
                    {"urls": url}
                    )
            print("✓ 获取评论成功:", res.content[0].text,"\n")
        except Exception as e:
            print(e,"\n获取评论失败")
    async def cleanup(self):
        """清理资源"""
        await self.exit_stack.aclose()
async def main():
    if len(sys.argv) < 2:
        # print("用法：python client.py <服务器脚本路径>")
        # sys.exit(1)
        server_path = "./chrome-devtools-mcp/build/src/index.js"
    else:
        server_path = sys.argv[1]

    client = MCPClient()
    try:
        await client.connect_to_server(server_path)
        
        # urls =  ['https://club.autohome.com.cn/bbs/thread/ef1e062e67662c15/114155755-1.html?bbsid=121#pvareaid=6830286',
        #          'https://club.autohome.com.cn/bbs/thread/b3aa5e8a72df8e82/114198440-1.html?bbsid=8045#pvareaid=6830286']
        
        # url = "https://club.autohome.com.cn/bbs/thread/ef1e062e67662c15/114155755-1.html?bbsid=121#pvareaid=6830286"
        url = input("测试用url:")
        res = await client.session.call_tool("extract_dcd_by_url", {"url": url})
        print(res.content[0].text)
        #await client.has_next_page()
        #await client.get_all_comment("https://www.dongchedi.com/community/145","./comments.json")
        #await client.try_tools("get_douyin_download_link", "https://www.douyin.com/jingxuan?modal_id=7596027582585128357")
        
    finally:
        await client.cleanup()

if __name__ == "__main__":
    import sys
    asyncio.run(main())