import asyncio
import json
import tempfile

from browser_agent import BrowserAgent, BrowserAgentTask


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="browser-agent-python-sdk-test-") as downloads:
        agent = BrowserAgent(
            provider="openai",
            model="gpt-5.4",
            headless=True,
            download_directory=downloads,
        )
        result = await agent.run(
            BrowserAgentTask(
                task="Open the page and return its title.",
                url="https://example.com",
            )
        ).result
        print(json.dumps({
            "status": result.status,
            "tasks": [
                {
                    "task_id": task.task_id,
                    "status": task.status,
                    "data": [run.data for run in task.runs],
                }
                for task in result.tasks
            ],
        }, indent=2))
        if result.status != "completed":
            raise RuntimeError("Python SDK smoke test did not complete.")


asyncio.run(main())
