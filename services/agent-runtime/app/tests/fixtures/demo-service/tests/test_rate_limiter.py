from backend.rate_limiter import TokenBucket


def test_allows_up_to_capacity():
    bucket = TokenBucket(capacity=2, refill_per_tick=1)
    assert bucket.allow() is True
    assert bucket.allow() is True
    assert bucket.allow() is False


def test_refills_on_tick():
    bucket = TokenBucket(capacity=1, refill_per_tick=1)
    assert bucket.allow() is True
    assert bucket.allow() is False
    bucket.tick()
    assert bucket.allow() is True
