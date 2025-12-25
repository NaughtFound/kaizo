Quick Start
===========

This guide demonstrates the minimal steps to run a Kaizo configuration file.


Minimal Example
---------------

Create a YAML file called ``hello.yaml``:

.. code-block:: yaml

   hello:
     module: builtins
     source: print
     args:
       - "Hello Kaizo"

Explanation:

- ``module``: Python module to load (`builtins` for standard Python functions)
- ``source``: The callable inside the module (`print`)
- ``args``: List of arguments passed to the callable

.. note::

   Kaizo converts this entry into a ``ModuleEntry`` internally.
   Accessing the entry triggers execution automatically because
   ``resolve=True`` by default.


Run the Configuration
~~~~~~~~~~~~~~~~~~~~~

.. code-block:: python

    from kaizo import ConfigParser

    parser = ConfigParser("hello.yaml")
    config = parser.parse()

    # Accessing the entry resolves and executes it
    config["hello"]  # Outputs: Hello Kaizo


Using Entry References
~~~~~~~~~~~~~~~~~~~~~~

You can reference other entries in the YAML configuration
using the ``.{entry_key}`` syntax:

.. code-block:: yaml

    greet:
        module: builtins
        source: print
        args:
        - .{name}

Explanation:

- ``.{name}`` references the entry with key ``name``.
- Kaizo resolves the reference automatically during parsing.

Python usage:

.. code-block:: python

    from kaizo import ConfigParser

    parser = ConfigParser("hello.yaml", kwargs={"name": "Kaizo"})
    config = parser.parse()
    config["greet"]  # Outputs: Kaizo

.. note::

   Entry references allow values to depend on other entries within the
   same configuration file. In this config, Kaizo resolves the ``.{name}`` placeholder using the runtime ``kwargs``.
   
   Resolution order is:

   1. Runtime keyword arguments (if provided)
   2. Local storage
   3. Imported modules
   4. Plugins
   5. Python modules


Caching and Lazy Execution
~~~~~~~~~~~~~~~~~~~~~~~~~~

Kaizo provides fine-grained control over **when** an entry is executed and
**whether** its result is reused.

Caching
^^^^^^^

By default, Kaizo **caches execution results** per entry based on the
resolved argument signature. Disabling caching forces the callable to execute **every time the entry
is accessed**.

Example:

.. code-block:: yaml

   random_value:
     module: random
     source: random
     cache: false

Usage:

.. code-block:: python

   result1 = config["random_value"]  # Executes random()
   result2 = config["random_value"]  # Executes again because cache=False

.. tip::

   Use ``cache: false`` when:
   
   - The callable has side effects
   - You need fresh results on every access
   - The function is non-deterministic (e.g. random values, timestamps)

Lazy Execution
^^^^^^^^^^^^^^

Setting ``lazy: true`` prevents immediate execution of the entry.

Instead of running the callable, Kaizo returns a **callable wrapper**
(``FnWithKwargs``) that can be executed later.

Example:

.. code-block:: yaml

   delayed_sleep:
     module: time
     source: sleep
     lazy: true
     args:
       - 2

Usage:

.. code-block:: python

   sleeper = config["delayed_sleep"]  # Does NOT sleep yet
   sleeper()                          # Sleeps for 2 seconds

This is useful for:

- Deferred execution
- Passing callables as values
- Building execution pipelines
- Avoiding work until explicitly needed

.. note::

   When ``lazy: true`` is enabled:
   
   - The entry returns a callable instead of a value
   - Execution only happens when the returned callable is invoked


Summary
-------

- Kaizo wraps every YAML entry in an **Entry object**
- Accessing an entry automatically **resolves** and optionally **executes** it
- Entries can reference other entries using ``.{entry_key}``
- ``ModuleEntry`` manages **call control, lazy execution, and caching**
