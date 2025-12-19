Installation
============

Kaizo can be installed either via **pip** or from **source**.


Install via pip
---------------

The simplest way to install Kaizo is from PyPI:

.. code-block:: bash

   pip install kaizo

.. note::

   This will install Kaizo and its dependencies system-wide or in your
   active virtual environment.


Install from Source
-------------------

To install the latest version from the GitHub repository:

.. code-block:: bash

   git clone https://github.com/NaughtFound/kaizo.git
   cd kaizo
   pip install -e .

.. tip::

   - The ``-e`` option installs in **editable mode**, allowing you to
     modify the source code and use it immediately without reinstalling.
   - Useful for development, debugging, or contributing to Kaizo.


Requirements
------------

Kaizo requires:

- **Python 3.10** or higher
- **PyYAML** (for parsing YAML configuration files)

.. warning::

   Using an older Python version may result in syntax errors or
   missing typing features, as Kaizo relies on modern type hints
   and data classes.
