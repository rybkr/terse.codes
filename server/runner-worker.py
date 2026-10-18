from __future__ import annotations

import contextlib
import __future__
import errno
import io
import json
import math
import os
import resource
import signal
import sys
from collections import deque
from types import CodeType
from typing import Callable, Deque, Dict, List, Optional, Sequence, Set, TextIO, Union, cast

JsonValue = Union[None, bool, int, float, str, List['JsonValue'], Dict[str, 'JsonValue']]


class TreeNode:
    def __init__(self, val: int = 0, left: Optional[TreeNode] = None, right: Optional[TreeNode] = None) -> None:
        self.val = val
        self.left = left
        self.right = right


class ListNode:
    def __init__(self, val: int = 0, next: Optional[ListNode] = None) -> None:
        self.val = val
        self.next = next


def tree_node(values: JsonValue) -> Optional[TreeNode]:
    if not values:
        return None
    items = cast(List[Optional[int]], values)
    root = TreeNode(cast(int, items[0]))
    pending: Deque[TreeNode] = deque([root])
    index = 1
    while pending and index < len(items):
        node = pending.popleft()
        for attribute in ('left', 'right'):
            if index < len(items) and items[index] is not None:
                child = TreeNode(cast(int, items[index]))
                setattr(node, attribute, child)
                pending.append(child)
            index += 1
    return root


def list_node(value: JsonValue) -> Optional[ListNode]:
    cycle = -1
    if isinstance(value, dict):
        cycle = cast(int, value['cycle'])
        value = value['values']
    nodes = [ListNode(item) for item in cast(List[int], value or [])]
    for left, right in zip(nodes, nodes[1:]):
        left.next = right
    if nodes and cycle >= 0:
        nodes[-1].next = nodes[cycle]
    return nodes[0] if nodes else None


def list_nodes(head: Optional[ListNode]) -> List[ListNode]:
    nodes: List[ListNode] = []
    seen: Set[int] = set()
    while head is not None:
        if id(head) in seen:
            raise ValueError('Returned list contains a cycle.')
        seen.add(id(head))
        nodes.append(head)
        head = head.next
    return nodes


def normalize(value: object) -> JsonValue:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return {'$bigint': str(value)} if abs(value) > 9007199254740991 else value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Return finite values.')
        return value
    if isinstance(value, ListNode):
        return [normalize(node.val) for node in list_nodes(value)]
    if isinstance(value, TreeNode):
        result: List[JsonValue] = []
        pending: Deque[Optional[TreeNode]] = deque([value])
        seen: Set[int] = set()
        while pending:
            node = pending.popleft()
            if node is None:
                result.append(None)
                continue
            if id(node) in seen:
                raise ValueError('Returned tree contains a cycle.')
            seen.add(id(node))
            result.append(normalize(node.val))
            pending.extend((node.left, node.right))
        while result and result[-1] is None:
            result.pop()
        return result
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in cast(Sequence[object], value)]
    if isinstance(value, dict):
        mapping = cast(Dict[object, object], value)
        if '$bigint' in mapping or '$json' in mapping:
            raise ValueError('JSON transport tags are reserved for the runner.')
        return {str(key): normalize(item) for key, item in mapping.items()}
    raise TypeError('Return a JSON value or a ListNode/TreeNode.')


def revive(value: JsonValue) -> JsonValue:
    if isinstance(value, dict):
        if set(value) == {'$bigint'}:
            return int(cast(str, value['$bigint']))
        for key, item in value.items():
            value[key] = revive(item)
        return value
    if isinstance(value, list):
        for index, item in enumerate(value):
            value[index] = revive(item)
        return value
    return value


def argument(value: JsonValue, annotation: str) -> object:
    annotation = annotation.replace('typing.', '').replace(' ', '')
    if annotation.startswith('Optional['):
        return argument(value, annotation[9:-1])
    if annotation in ('TreeNode', 'TreeNode|None'):
        return tree_node(value)
    if annotation in ('ListNode', 'ListNode|None'):
        return list_node(value)
    if 'Node' in annotation and annotation.startswith(('List[', 'list[')):
        return [argument(item, annotation[5:-1]) for item in cast(List[JsonValue], value)]
    return value


def special_tree(root: Optional[TreeNode]) -> None:
    leaves: List[TreeNode] = []
    pending = [root] if root else []
    while pending:
        node = pending.pop()
        if node.left is None and node.right is None:
            leaves.append(node)
        else:
            if node.left:
                pending.append(node.left)
            if node.right:
                pending.append(node.right)
    leaves.sort(key=lambda node: node.val)
    for index, leaf in enumerate(leaves):
        leaf.left = leaves[index - 1]
        leaf.right = leaves[(index + 1) % len(leaves)]


def install_seccomp() -> None:
    import ctypes

    machine = os.uname().machine
    syscall_numbers = {
        'x86_64': (0xC000003E, [56, 57, 58, 59, 101, 155, 161, 165, 166, 169, 175, 176, 246,
                               248, 249, 250, 272, 288, 298, 303, 304, 308, 310, 311, 313, 321,
                               322, 425, 435, 438, 41, 42, 53]),
        'aarch64': (0xC00000B7, [39, 40, 41, 51, 97, 104, 105, 106, 117, 142, 198, 199, 203,
                                217, 218, 219, 220, 221, 241, 264, 265, 268, 270, 271, 273, 280,
                                281, 425, 435, 438]),
    }
    architecture = syscall_numbers.get(machine)
    if architecture is None:
        raise OSError('Unsupported seccomp architecture.')

    class SockFilter(ctypes.Structure):
        _fields_ = [
            ('code', ctypes.c_ushort),
            ('jump_true', ctypes.c_ubyte),
            ('jump_false', ctypes.c_ubyte),
            ('value', ctypes.c_uint32),
        ]

    class SockProgram(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(SockFilter))]

    instructions: List[tuple[int, int, int, int]] = [(0x20, 0, 0, 4), (0x15, 1, 0, architecture[0]),
                                                       (0x06, 0, 0, 0x00050000 | errno.EPERM),
                                                       (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000),
                                                       (0x06, 0, 0, 0x00050000 | errno.EPERM)]
    for syscall_number in architecture[1]:
        instructions.extend(((0x15, 0, 1, syscall_number),
                             (0x06, 0, 0, 0x00050000 | errno.EPERM)))
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    filters = (SockFilter * len(instructions))(*(SockFilter(*instruction) for instruction in instructions))
    program = SockProgram(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(39, 0, None, 0, 0) != 1:
        raise OSError('Bubblewrap did not set no-new-privileges.')
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Could not enable syscall filtering.')


class CapturedOutput(io.TextIOBase):
    def __init__(self) -> None:
        self.value = ''

    def write(self, text: str) -> int:
        self.value = (self.value + text)[:5000]
        return len(text)


def run_case(raw_input: List[JsonValue], request: Dict[str, object], common: Dict[str, object], compiled: CodeType) -> Dict[str, str]:
    parameters = cast(List[Dict[str, str]], request['parameters'])
    entry_point = cast(str, request['entryPoint'])
    adapter = cast(Optional[str], request.get('adapter'))
    stdout = CapturedOutput()
    stderr = CapturedOutput()
    record: Dict[str, str] = {}
    try:
        signal.setitimer(signal.ITIMER_REAL, 5)
        with contextlib.redirect_stdout(cast(TextIO, stdout)), contextlib.redirect_stderr(cast(TextIO, stderr)):
            args = [argument(revive(value), parameter['type']) for value, parameter in zip(raw_input, parameters)]
            if adapter == 'special-tree':
                special_tree(cast(Optional[TreeNode], args[0]))
            original = list_nodes(cast(Optional[ListNode], args[0])) if adapter in ('middle-list', 'reuse-list') else []
            original_values = [node.val for node in original]
            namespace = dict(common)
            namespace.update({'stdout': stdout, 'stderr': stderr})
            exec(compiled, namespace)
            candidate = cast(Callable[..., object], eval(entry_point, namespace))
            actual = candidate(*args)
            return_type = cast(str, request['returnType'])
            if 'ListNode' in return_type and actual is not None and not isinstance(actual, ListNode):
                raise TypeError('Return a ListNode.')
            if 'TreeNode' in return_type and actual is not None and not isinstance(actual, TreeNode):
                raise TypeError('Return a TreeNode.')
            if adapter == 'prefix':
                length = cast(int, actual)
                actual = [length, cast(List[object], args[0])[:length]]
            elif adapter == 'middle-list':
                expected_node = original[len(original) // 2] if original else None
                if actual is not expected_node:
                    raise ValueError('Return the original middle node.')
            elif adapter == 'reuse-list':
                k = cast(int, args[1])
                expected_nodes: List[ListNode] = []
                for index in range(0, len(original), k):
                    group = original[index:index + k]
                    expected_nodes.extend(reversed(group) if len(group) == k else group)
                returned = list_nodes(cast(Optional[ListNode], actual))
                if len(returned) != len(expected_nodes) or any(left is not right for left, right in zip(returned, expected_nodes)) \
                        or [node.val for node in original] != original_values:
                    raise ValueError('Reuse original nodes in the required group order without changing values.')
            elif adapter == 'mutated-tree' and normalize(args[0]) != normalize(actual):
                raise ValueError('Mutate the original tree.')
            if actual is None and ('TreeNode' in return_type or 'ListNode' in return_type):
                actual = []
            record['output'] = json.dumps(normalize(actual), ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    except Exception as error:
        record['error'] = 'Runtime error: ' + type(error).__name__ + ': ' + str(error)[:200]
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    record.update({'stdout': stdout.value, 'stderr': stderr.value})
    return record


def main() -> None:
    request = cast(Dict[str, object], json.loads(sys.stdin.readline()))
    memory = cast(int, request['memoryLimitMb']) * 1024 * 1024
    cpu = cast(int, request['cpuLimitSeconds'])
    strict_limits = cast(bool, request.get('strictResourceLimits', False))
    for limit, bounds in (
        (resource.RLIMIT_CPU, (cpu, cpu + 1)),
        (resource.RLIMIT_AS, (memory, memory)),
        (resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024)),
        (resource.RLIMIT_NPROC, (0, 0)),
        (resource.RLIMIT_NOFILE, (64, 64)),
        (resource.RLIMIT_CORE, (0, 0)),
    ):
        try:
            resource.setrlimit(limit, bounds)
        except (ValueError, OSError):
            if strict_limits:
                raise
    if strict_limits:
        try:
            import ctypes
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), 'prctl')
        except (AttributeError, OSError) as error:
            sys.stderr.write('Could not enable parent-death handling: ' + str(error)[:200] + '\n')
            os._exit(70)
    common: Dict[str, object] = {}
    exec('''import collections, functools, itertools, heapq, bisect, math, random, re, string
from typing import *
from string import *
from re import *
from datetime import *
from collections import *
from heapq import *
from bisect import *
from copy import *
from math import *
from random import *
from statistics import *
from itertools import *
from functools import *
from operator import *
from io import *
from sys import *
from json import *
from builtins import *
from sortedcontainers import *
''', common)
    common.update({'TreeNode': TreeNode, 'ListNode': ListNode})
    if strict_limits:
        try:
            install_seccomp()
        except (AttributeError, OSError) as error:
            sys.stderr.write('Could not enable syscall filtering: ' + str(error)[:200] + '\n')
            os._exit(70)
    if request.get('probe') is True:
        parent_netns = cast(str, request['parentNetNs'])
        if os.path.exists('/app/package.json') or os.readlink('/proc/self/ns/net') == parent_netns:
            os._exit(71)
        sys.stdout.write('{"probe":"ok"}\n')
        sys.stdout.flush()
        return
    code = cast(str, request['code'])
    try:
        compiled = compile(code, 'submission.py', 'exec', flags=__future__.annotations.compiler_flag)
    except SyntaxError as error:
        sys.stdout.write(json.dumps({'error': 'Compilation error: ' + str(error)[:300]}) + '\n')
        return
    def timeout(_signum: int, _frame: object) -> None:
        raise TimeoutError('Testcase time limit exceeded.')

    signal.signal(signal.SIGALRM, timeout)
    for line in sys.stdin:
        raw_input = cast(List[JsonValue], json.loads(line))
        record = run_case(raw_input, request, common, compiled)
        del raw_input
        message = json.dumps(record, ensure_ascii=False, separators=(',', ':'))
        if len(message.encode('utf-8')) > cast(int, request['outputLimit']):
            sys.stdout.write(json.dumps({'error': 'Output limit exceeded.'}) + '\n')
            return
        sys.stdout.write(message + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
