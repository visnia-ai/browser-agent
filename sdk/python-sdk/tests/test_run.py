from __future__ import annotations

import asyncio
import unittest

from browser_agent import BrowserAgentTask
from browser_agent.rpc import RpcState
from browser_agent.run import BrowserAgentRun
from tests.helpers import create_agent, fake_environment
from tests.test_options import valid


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_and_setup_cancellation_are_idempotent(self) -> None:
        with fake_environment("wait"):
            started = asyncio.Event()
            run = create_agent().run(
                BrowserAgentTask("wait"),
                on_event=lambda event: (
                    started.set() if event.type == "run_started" else None
                ),
            )
            await started.wait()
            await asyncio.gather(run.cancel(), run.cancel())
            self.assertEqual((await run.result).status, "cancelled")

        pending = asyncio.get_running_loop().create_future()
        early = BrowserAgentRun(
            "early",
            valid(),
            [BrowserAgentTask("early")],
            pending,
            None,
        )
        cancellation = asyncio.create_task(early.cancel())
        await asyncio.sleep(0)
        pending.set_result("/unused")
        await cancellation
        self.assertEqual((await early.result).status, "cancelled")

    async def test_success_and_callback_isolation(self) -> None:
        with fake_environment("success"):
            run = create_agent().run(
                BrowserAgentTask("ok"),
                on_event=lambda _: (_ for _ in ()).throw(RuntimeError("consumer")),
            )
            self.assertEqual((await run.result).status, "completed")
            keyless = create_agent(
                provider="vllm",
                model="qwen",
                api_key=None,
                endpoint_url="http://localhost:8000",
            )
            self.assertEqual(
                (await keyless.run(BrowserAgentTask("ok")).result).status,
                "completed",
            )
            agent = create_agent()
            first, second = await asyncio.gather(
                agent.run(BrowserAgentTask("first concurrent")).result,
                agent.run(BrowserAgentTask("second concurrent")).result,
            )
            self.assertNotEqual(first.run_id, second.run_id)

    async def test_all_protocol_rpc_and_process_failures(self) -> None:
        cases = [
            ("malformed", "PROTOCOL_ERROR"),
            ("invalid-message", "PROTOCOL_ERROR"),
            ("invalid-ack", "PROTOCOL_ERROR"),
            ("reject", "CHROME_NOT_FOUND"),
            ("rpc-error", "PROCESS_EXITED"),
            ("early-exit", "PROCESS_EXITED"),
            ("nonzero-complete", "PROCESS_EXITED"),
            ("incomplete", "PROTOCOL_ERROR"),
        ]
        for mode, code in cases:
            with self.subTest(mode=mode), fake_environment(mode):
                tasks = (
                    [BrowserAgentTask("one"), BrowserAgentTask("two")]
                    if mode == "incomplete"
                    else BrowserAgentTask("one")
                )
                run = create_agent().run(tasks)
                with self.assertRaises(Exception) as caught:
                    await run.result
                self.assertEqual(caught.exception.code, code)
                events = [event async for event in run.events()]
                self.assertEqual(events[-1].type, "error")

    async def test_terminal_helpers_are_idempotent(self) -> None:
        pending = asyncio.get_running_loop().create_future()
        run = BrowserAgentRun(
            "helpers",
            valid(),
            [BrowserAgentTask("helpers")],
            pending,
            None,
        )
        run.result.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await run.result

        class Process:
            async def wait(self):
                return 0

        terminal = asyncio.get_running_loop().create_future()
        run._terminal = terminal
        run._cancel_requested = True
        await run._watch_exit(
            type("Agent", (), {"process": Process()})(),  # type: ignore[arg-type]
        )
        self.assertEqual(terminal.result(), "cancelled")
        await run._watch_exit(
            type("Agent", (), {"process": Process()})(),  # type: ignore[arg-type]
        )

        run._terminal = None
        run._settle("ignored")
        run._terminal = terminal
        run._settle("completed")
        run._settle(RuntimeError("ignored"))

        class Messages:
            async def messages(self):
                yield {"jsonrpc": "2.0", "method": "ignored"}

        run._rpc = RpcState("helpers", [], [])
        run._terminal = asyncio.get_running_loop().create_future()
        await run._pump(Messages())  # type: ignore[arg-type]
