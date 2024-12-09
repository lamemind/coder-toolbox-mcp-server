# Coder Toolbox MCP Server

A utility toolkit designed to enhance the interaction between Claude and code, providing seamless integration tools for
code analysis, manipulation, and testing workflows.

## Features

### Implemented

#### Test Execution Logs
- Retrieve and analyze test execution logs
- Access detailed test results and output
- Parse and format test execution data

#### Class Location
- Find Java class files in project source code
- Support for both main and test classes
- Optional package path filtering
- Returns file location and content

#### Method Addition
- Add new methods to existing Java classes
- Preserves file structure and formatting
- Automatic class file updating

## Tools

### get_test_logs
- Retrieve test execution logs

### locate_class
- Parameters:
  - `className` (string): Name of the class to find (case sensitive)
  - `packagePath` (string, optional): Package path to restrict search (e.g. 'com.myself.myproject')
  - `isTestClass` (boolean, default false): Whether to search in test or main source directory
- Returns: JSON object containing:
  - `found` (boolean): Whether the class was found
  - `filepath` (string, optional): Relative path to the found file
  - `content` (string, optional): Content of the found file

### add_method
- Parameters:
  - All parameters from locate_class, plus:
  - `methodBody` (string): Full method declaration including modifiers, return type, name, parameters and body
- Returns: JSON object containing:
  - `success` (boolean): Whether the method was added
  - `filepath` (string, optional): Path of the modified file
  - `error` (string, optional): Error message if operation failed

## Development Roadmap

- [x] Test execution log retrieval
- [x] Class-based code navigation
- [x] Method-level file modification
- [ ] Agnostic code file generation

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.