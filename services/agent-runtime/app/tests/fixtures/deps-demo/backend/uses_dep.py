"""Deliberately depends on a third-party package (declared in requirements.txt)
so this fixture can only pass its tests if the sandbox's setup phase actually
installed it."""

import six


def describe() -> str:
    return f"six version: {six.__version__}"
