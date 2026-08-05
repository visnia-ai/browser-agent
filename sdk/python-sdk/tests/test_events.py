from __future__ import annotations

import asyncio
import unittest

from browser_agent.events import ReplayEvents


class EventTests(unittest.IsolatedAsyncioTestCase):
    async def test_streams_replays_closes_and_ignores_late_items(self) -> None:
        events = ReplayEvents[int]()

        async def collect() -> list[int]:
            return [item async for item in events.iterate()]

        reading = asyncio.create_task(collect())
        await asyncio.sleep(0)
        events.publish(1)
        events.publish(2)
        events.close()
        events.publish(3)
        self.assertEqual(await reading, [1, 2])
        self.assertEqual(await collect(), [1, 2])

    async def test_cancelled_iterator_removes_its_waiter(self) -> None:
        events = ReplayEvents[int]()
        iterator = events.iterate()
        pending = asyncio.create_task(anext(iterator))
        await asyncio.sleep(0)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        done = asyncio.get_running_loop().create_future()
        done.set_result(None)
        events._waiters.add(done)
        events.close()
