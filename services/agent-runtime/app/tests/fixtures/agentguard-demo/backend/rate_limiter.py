"""A tiny token-bucket rate limiter used by the AgentGuard demo API."""


class TokenBucket:
    def __init__(self, capacity: int, refill_per_tick: int) -> None:
        self.capacity = capacity
        self.refill_per_tick = refill_per_tick
        self.tokens = capacity

    def allow(self) -> bool:
        """Consume one token if available."""
        raise NotImplementedError  # devroom:implement self._consume()

    def _consume(self) -> bool:
        if self.tokens > 0:
            self.tokens -= 1
            return True
        return False

    def tick(self) -> None:
        self.tokens = min(self.capacity, self.tokens + self.refill_per_tick)
