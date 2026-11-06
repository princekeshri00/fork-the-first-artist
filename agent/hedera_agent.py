import asyncio
import os
from dotenv import load_dotenv

from hiero_sdk_python import Client, Network, AccountId, PrivateKey
from hedera_agent_kit.langchain.toolkit import HederaLangchainToolkit
from hedera_agent_kit.shared.configuration import Configuration, Context, AgentMode
from hedera_agent_kit.plugins import (
    core_account_plugin,
    core_account_query_plugin,
    core_consensus_plugin,
    core_consensus_query_plugin,
    core_token_plugin,
)
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

load_dotenv()

async def main():
    client = Client(Network(network="testnet"))
    account_id = AccountId.from_string(os.getenv("ACCOUNT_ID"))
    private_key = PrivateKey.from_string(os.getenv("PRIVATE_KEY"))
    client.set_operator(account_id, private_key)

    # 2. Give the AI Agent permission to use Hedera Consensus (Topics) & Account tools
    configuration = Configuration(
        context=Context(
            mode=AgentMode.AUTONOMOUS,
            account_id=str(account_id),
        ),
        plugins=[
            core_account_plugin,
            core_account_query_plugin,
            core_consensus_plugin,
            core_consensus_query_plugin,
            core_token_plugin,
        ],
    )

    hedera_toolkit = HederaLangchainToolkit(
        client=client,
        configuration=configuration,
    )
    tools = hedera_toolkit.get_tools()

    llm = ChatOpenAI(model="gpt-4o-mini", api_key=os.getenv("OPENAI_API_KEY"))
    agent = create_react_agent(llm, tools)

    prompt = (
        "1. Check my current HBAR balance. "
        "2. Create a new Hedera topic with the memo 'OSO-Garden-Circle-Log'. "
        "3. Submit the message 'Artist node initialized: aniket-gundewar joined the Mumbai circle' to that new topic. "
        "4. Tell me the new Topic ID and transaction status."
    )

    print("Running Steward AI Agent on Hedera Testnet...\n")
    response = await agent.ainvoke(
        {"messages": [{"role": "user", "content": prompt}]}
    )

    print("\n--- AGENT RESPONSE ---")
    print(response["messages"][-1].content)

if __name__ == "__main__":
    asyncio.run(main())