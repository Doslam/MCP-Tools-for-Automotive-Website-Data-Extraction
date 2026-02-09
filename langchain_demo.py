from http import client
import os
from unittest import result



try:
    from dataclasses import dataclass
    from langchain_mcp_adapters.tools import load_mcp_tools
    from langchain.tools import tool, ToolRuntime
    from langchain.agents import create_agent
    from langchain_openai import ChatOpenAI
    from langgraph.checkpoint.memory import InMemorySaver
except ImportError:
    print("请安装 langchain, langchain_community, langgraph 等相关模块")
try:
    from client import MCPClient
    import asyncio
    from typing import Any, Dict, List
except ImportError:
    print("请安装其他相关模块")

async def langchain_main(client: MCPClient = MCPClient()):
    BASE_URL = "your local model address"


    SYSTEM_PROMPT = """
    你是一个智能自动化助手，可以调用 MCP 工具来操作浏览器。

    mcp工具使用规则：
    1. 任何需要页面元素 UID 的操作（如 click、fill、hover）前，
    必须先调用 take_snapshot，并保存返回的 snapshot 结果。
    2. 如果调用后续工具时遇到 “No snapshot found”，
    请重新执行 take_snapshot，然后再调用。
    3. 每次工具调用必须按 JSON 格式输出，不要直接生成自然语言操作。
    4. 工具调用顺序必须严格按照依赖关系，例如：
    - 调用 snapshot
    - 使用 snapshot 提取 UID
    - 使用 UID 调用 click/fill 等
    - 若页面 DOM 改变，请再 snapshot
    5. 输出中必须包含所有工具运行结果，模型才继续下一步。

    反复点击保护（强制）

    不允许连续两次点击同一个元素（同一个 uid 或同一文本，如“南京”）。

    点击后如果 URL 没变化、页面标题没变化、或连续两次 snapshot 的核心内容相同，则判定“无进展”。

    一旦判定无进展：停止继续点击，改为直接从当前页面提取天气信息并输出最终答案；如果无法提取，输出失败原因并结束。
    """

    tools = await load_mcp_tools(client.session)

    @dataclass
    class Context:
        """Custom runtime context schema."""
        user_id: str

    @tool
    def get_user_location(runtime: ToolRuntime[Context]) -> str:
        """Retrieve user information based on user ID."""
        user_id = runtime.context.user_id
        return "Florida" if user_id == "1" else "SF"


    @dataclass
    class ResponseFormat:
        """Response schema for the agent."""
        # A punny response (always required)
        punny_response: str
        # Any interesting information about the weather if available
        weather_conditions: str | None = None

    checkpointer = InMemorySaver()
    
    model=ChatOpenAI(
            model_name="Qwen3-30B-A3B", #你的模型
            base_url = BASE_URL,
            api_key = "local-llm", #你的api key
            temperature=0,
            max_tokens=512,
            timeout=60
        )
    agent = create_agent(
        model = model,
        system_prompt=SYSTEM_PROMPT,
        tools= list(tools) + [get_user_location],
        context_schema=Context,
        #response_format=ToolStrategy(ResponseFormat),
        checkpointer=checkpointer
    )



    # `thread_id` is a unique identifier for a given conversation.
    config = {"configurable": {"thread_id": "1"}}


    question = input("""请输入你想咨询的问题，例如“佛罗里达今天的天气如何？”或“帮我用MCP工具获取...的详情""")
    #insertquestion = "用你所能用的工具获取https://www.dongchedi.com/ugc/article/1853526256983114 和 https://www.dongchedi.com/ugc/article/1840941554494467上的详情"
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": insertquestion}]},
    config=config,
    context=Context(user_id="1")
    )

    def printformmat(res:str):
        "将res输出成一定格式：每次左括号或左大括号后换行且括号内内容缩减count个缩进符，逗号后换行。忽略引号内的括号和逗号"
        inc = "    "
        count =0
        output = ""
        for j in range(len(res)):
            i = res[j]
            #当在引号内时，忽略括号和逗号
            
            if i in '([{':
                count += 1
                output += i + "\n" + inc * count
            elif i in ')]}' :
                count -= 1
                output += i 
            elif i == ' ' and res[j-1] == ',' :
                output += "\n" + inc * count
            else:
                output += i
            
        #把输出保存到./aoutput.json文件中
        with open("D:\\py_dev\\demo\\modeloutput.json", "w", encoding="utf-8") as f:
            f.write(output)

    printformmat(str(result))
    

async def main():
    client = MCPClient()
    try:
        await client.connect_to_server("./chrome-devtools-mcp/build/src/index.js")
        await langchain_main(client)
        
    except Exception as e:
        print("Error in main:", e)
    finally:
        await client.cleanup()


if __name__ == "__main__":
    asyncio.run(main())


