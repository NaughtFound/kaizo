Utilities
=========

Kaizo provides several utility classes that manage execution,
resolution, and storage of configuration entries. These utilities form
the backbone of the parser's behavior.


Entry System
------------

The **Entry system** defines how Kaizo wraps, resolves, and executes
values from configuration files. Every parsed value becomes an
``Entry`` or subclass.


Entry (Abstract)
~~~~~~~~~~~~~~~~

The base class for all Kaizo entries.

- Defines a unified ``__call__`` interface
- Ensures lazy resolution and caching are applied consistently
- Supports extension for custom behavior

.. important::

   You should not instantiate ``Entry`` directly. Use one of its
   concrete subclasses: ``FieldEntry``, ``DictEntry``, ``ListEntry``,
   or ``ModuleEntry``.


FieldEntry
~~~~~~~~~~

Represents a **literal value**.

- Returns the stored value when called
- No lazy evaluation or execution

Example:

.. code-block:: python

   from kaizo.utils import FieldEntry

   entry = FieldEntry(key="pi", value=3.14)
   print(entry())  # Outputs: 3.14


DictEntry
~~~~~~~~~

Represents a **mapping of keys to entries**.

- Resolves entries **on access**
- Supports caching
- Implements the full mapping interface

Example:

.. code-block:: python

   from kaizo.utils import DictEntry, FieldEntry

   d = DictEntry()
   d["a"] = FieldEntry("a", 1)
   d["b"] = FieldEntry("b", 2)
   print(d["a"])  # Outputs: 1

.. note::

   Iterating or accessing values will trigger ``__call__`` on each child
   entry if ``resolve=True``.


ListEntry
~~~~~~~~~

Represents a **sequence of entries**.

- Resolves each element individually
- Supports caching
- Implements the full sequence interface

Example:

.. code-block:: python

   from kaizo.utils import ListEntry, FieldEntry

   l = ListEntry([FieldEntry("x", 10), FieldEntry("y", 20)])
   print(l[0])  # Outputs: 10
   print(l[1])  # Outputs: 20

.. note::

   Supports nested lists and mixed entry types. Resolution happens per
   element.


ModuleEntry
~~~~~~~~~~~

Wraps **executable logic** and controls execution behavior.

Features:

- **Call control**: call object, return raw object, or call a method
- **Lazy execution**: only evaluates when accessed
- **Result caching**: caches results by argument identity
- **Argument hashing**: manages unique result buckets per argument set

Example:

.. code-block:: python

   from kaizo.utils import ModuleEntry, FieldEntry, ListEntry
   from kaizo.utils import FnWithKwargs

   def add(a, b):
       return a + b

   args = ListEntry([FieldEntry("a", 10), FieldEntry("b", 20)])
   entry = ModuleEntry(key="sum", obj=add, call=True, lazy=False, args=args)
   print(entry())  # Outputs: 30

.. important::

   ModuleEntry is used internally for ``module + source`` entries
   in YAML configurations.


FnWithKwargs
------------

A **wrapper around Python callables** that stores positional and
keyword arguments.

- Allows arguments to be pre-resolved and injected during execution
- Supports multiple calls with updated kwargs
- Used internally by ``ModuleEntry`` and plugin dispatch

Example:

.. code-block:: python

   from kaizo.utils import FnWithKwargs

   def greet(name, sep="-"):
       return f"Hello{sep}{name}"

   fn = FnWithKwargs(fn=greet, args=("Alice",), kwargs={"sep": "!"})
   print(fn())  # Outputs: Hello!Alice
   fn.update(sep="~")
   print(fn())  # Outputs: Hello~Alice


ModuleLoader
------------

Utility to **dynamically load Python modules and objects**.

Features:

- Load a Python file as a module
- Load an object from a module path

Example:

.. code-block:: python

   from kaizo.utils import ModuleLoader

   mod = ModuleLoader.load_python_module("./helpers.py")
   func = ModuleLoader.load_object("math", "sqrt")
   print(func(16))  # Outputs: 4.0

.. warning::

   Loading fails if the module or object does not exist.


Storage
-------

Stores **resolved entries** for reference lookup.

- Keeps a mapping of keys to ``Entry`` objects
- Supports fetching by key or returning the stored top-level value
- Used by ``ConfigParser`` to manage local and imported entries

Example:

.. code-block:: python

   from kaizo.utils import Storage, FieldEntry

   storage = Storage.init()
   storage.set("x", FieldEntry("x", 42))
   print(storage.get("x")())  # Outputs: 42

.. note::

   Storage allows Kaizo to resolve references across modules, plugins,
   and runtime keyword arguments consistently.


Exception Handling
------------------

Kaizo provides a configurable exception handling mechanism that controls
how errors are treated during entry execution.

This behavior is implemented through ``ExceptionPolicy`` and
``ExceptionHandler`` and is primarily used by ``ModuleEntry``.

ExceptionPolicy
~~~~~~~~~~~~~~~

``ExceptionPolicy`` defines how exceptions raised during execution
should be handled.

Supported policies:

- ``RAISE`` *(default)*  
  Propagates the exception normally.

- ``IGNORE``  
  Suppresses matching exceptions and returns ``None``.

ExceptionHandler
~~~~~~~~~~~~~~~~

``ExceptionHandler`` is a context manager that applies the selected
exception policy during execution.

Internally, it wraps callable execution and decides whether to
suppress or propagate exceptions based on the configured policy.

Key characteristics:

- Applies only to specified exception types
- Defaults to handling ``Exception``
- Uses standard ``with`` context semantics

Simplified usage:

.. code-block:: python

   from kaizo.utils import ExceptionHandler, ExceptionPolicy

   with ExceptionHandler(policy=ExceptionPolicy.IGNORE):
       risky_function()


Integration with ModuleEntry
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Each ``ModuleEntry`` creates its own ``ExceptionHandler`` instance
based on the configured ``policy``.

During execution:

- The callable is invoked inside the exception handler
- If an exception occurs:
  - ``RAISE`` propagates the error
  - ``IGNORE`` suppresses it and returns ``None``

.. note::

   Exception handling occurs **at execution time**, not during parsing.


Configuration Example
~~~~~~~~~~~~~~~~~~~~~

Exception handling can be configured directly in YAML:

.. code-block:: yaml

   safe_task:
     module: unstable.module
     source: risky_function
     policy: ignore

In this example, any raised exception during execution is suppressed,
allowing the configuration to continue executing without failure.

.. important::

   Exception handling does **not** prevent argument resolution or
   callable preparation errors. It only applies to runtime execution.
