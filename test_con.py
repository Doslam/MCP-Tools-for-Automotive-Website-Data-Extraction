from langchain_community.chat_models import ChatZhipuAI
from langchain.messages import AIMessage, HumanMessage, SystemMessage   
import os
from dotenv import load_dotenv

load_dotenv()

zhipuaiapi_key = os.getenv("ZHIPU_API_KEY")
print(zhipuaiapi_key)

chat = ChatZhipuAI(
    api_key=zhipuaiapi_key,
    model="glm-4",
    temperature=0.5,
)
messages = [
    AIMessage(content="Hi."),
    SystemMessage(content="Your role is a poet."),
    HumanMessage(content="Write a short poem about AI in four lines."),
]
response = chat.invoke(messages)
print(response.content)  # Displays the AI-generated poem