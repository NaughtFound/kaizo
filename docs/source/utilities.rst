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
