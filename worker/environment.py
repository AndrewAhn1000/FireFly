from dataclasses import dataclass
from typing import Protocol
import math


@dataclass(frozen=True)
class Transition:
    """Continuing-task transition; event reward is not a causal action label."""
    timestamp: float
    next_timestamp: float
    observation_schema: str
    action_schema: str
    observation: tuple[float, ...]
    action: tuple[bool, ...]
    reward: float
    next_observation: tuple[float, ...]
    terminal: bool = False

    def __post_init__(self):
        if (not self.observation_schema or not self.action_schema or not self.observation or
                len(self.observation) != len(self.next_observation) or not self.action or
                any(type(value) is not bool for value in self.action) or
                not all(math.isfinite(value) for value in (*self.observation, *self.next_observation,
                                                           self.timestamp, self.next_timestamp, self.reward)) or
                self.next_timestamp <= self.timestamp):
            raise ValueError('Invalid continuing-task transition')


class ContinuingEnvironment(Protocol):
    """Adapter contract only: no optimizer or mandatory reset operation."""
    def observe(self) -> tuple[float, ...]: ...
    def step(self, action: tuple[bool, ...]) -> Transition: ...
    def release(self) -> None: ...
